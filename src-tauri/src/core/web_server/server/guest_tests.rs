use super::*;
use super::guest_api::Endpoint;
use crate::core::guest::store::{self as guest_store, Store as GuestStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn only_the_five_guest_shapes_parse() {
    let token = "a".repeat(32);
    let ok = [
        (Method::GET, format!("/g/{token}"), Endpoint::Page),
        (Method::POST, format!("/g/{token}/join"), Endpoint::Join),
        (Method::GET, format!("/g/{token}/snapshot"), Endpoint::Snapshot),
        (Method::GET, format!("/g/{token}/events"), Endpoint::Events),
        (Method::POST, format!("/g/{token}/message"), Endpoint::Message),
    ];
    for (method, path, want) in &ok {
        assert_eq!(guest_api::parse(method, path), Some((*want, token.as_str())), "{method} {path}");
        assert_eq!(route_auth(method, path), Auth::Public, "{method} {path}");
    }
    for (method, path) in [
        (Method::POST, format!("/g/{token}")),
        (Method::GET, format!("/g/{token}/join")),
        (Method::GET, format!("/g/{token}/message")),
        (Method::DELETE, format!("/g/{token}/message")),
        (Method::PUT, format!("/g/{token}")),
        (Method::GET, format!("/g/{token}/")),
        (Method::GET, format!("/g/{token}/snapshot/extra")),
        (Method::GET, format!("/g/{token}/threads")),
        (Method::GET, format!("/g/{token}/../api/v1/threads")),
        (Method::GET, "/g/".to_string()),
        (Method::GET, "/g".to_string()),
        (Method::GET, "/guest/x".to_string()),
        (Method::GET, format!("/g/{}", "x".repeat(65))),
    ] {
        assert_eq!(guest_api::parse(&method, &path), None, "{method} {path}");
        assert_eq!(route_auth(&method, &path), Auth::Session, "{method} {path}");
    }
}

#[test]
fn the_page_policy_loads_nothing_and_allows_only_its_own_code() {
    let csp = guest_api::page_csp();
    assert!(csp.starts_with("default-src 'none';"));
    assert!(!csp.contains("unsafe-inline") && !csp.contains("unsafe-eval") && !csp.contains("http"));
    assert!(csp.contains("script-src 'sha256-") && csp.contains("style-src 'sha256-"));
    assert!(csp.contains("connect-src 'self'") && csp.contains("frame-ancestors 'none'"));
    // The page itself pulls nothing from elsewhere.
    let html = include_str!("guest_page.html");
    for bad in ["http://", "https://", "<link", "<img", "<iframe", "src=", "@import", "innerHTML", "eval("] {
        assert!(!html.contains(bad), "the guest page must not contain {bad}");
    }
}

#[test]
fn a_share_holds_at_most_three_streams() {
    let a = guest_api::StreamSlot::take("share-x").unwrap();
    let b = guest_api::StreamSlot::take("share-x").unwrap();
    let c = guest_api::StreamSlot::take("share-x").unwrap();
    assert!(guest_api::StreamSlot::take("share-x").is_none());
    assert!(guest_api::StreamSlot::take("share-y").is_some());
    drop(a);
    let d = guest_api::StreamSlot::take("share-x").unwrap();
    drop((b, c, d));
}

/// One raw request; the whole answer (head and body) as text.
async fn raw(addr: &str, method: &str, path: &str, headers: &str, body: &str) -> String {
    let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(request.as_bytes()).await;
    let mut out = Vec::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), sock.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

fn code(answer: &str) -> u16 {
    answer.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn header_of(answer: &str, name: &str) -> Option<String> {
    answer
        .split("\r\n\r\n")
        .next()?
        .lines()
        .find_map(|l| l.to_ascii_lowercase().starts_with(&format!("{name}:")).then(|| l[name.len() + 1..].trim().to_owned()))
}

/// Reads from a stream until `needle` shows up in what has been read, or time runs out.
async fn read_until(sock: &mut tokio::net::TcpStream, seen: &mut String, needle: &str, secs: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while !seen.contains(needle) && std::time::Instant::now() < deadline {
        let mut buf = [0u8; 8192];
        if let Ok(Ok(n)) = tokio::time::timeout(std::time::Duration::from_millis(500), sock.read(&mut buf)).await {
            if n == 0 {
                break;
            }
            seen.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
    }
    seen.contains(needle)
}

const MESSAGES: &str = concat!(
    r#"{"id":"m1","thread_id":"t1","role":"user","content":[{"type":"text","text":{"value":"What is the plan?"}}]}"#,
    "\n",
    r#"{"id":"m2","thread_id":"t1","role":"assistant","content":[{"type":"tool_call","tool_name":"bash","input":"TOOL-INPUT-LEAK","output":"TOOL-OUTPUT-LEAK"},{"type":"reasoning","text":{"value":"REASONING-LEAK"}},{"type":"text","text":{"value":"Ship on Friday."}}]}"#,
    "\n",
    r#"{"id":"m3","thread_id":"t1","role":"system","content":[{"type":"text","text":{"value":"SYSTEM-PROMPT-LEAK"}}]}"#,
    "\n",
);

/// A real server: every guest rule from the outside, in one run (the limiter is
/// shared by the process, so its exhaustion comes last).
#[tokio::test]
async fn guest_routes_over_a_real_socket() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "ok").unwrap();
    let data = dir.path().join("data");
    let thread = data.join("threads").join("t1");
    std::fs::create_dir_all(&thread).unwrap();
    std::fs::write(thread.join("thread.json"), r#"{"id":"t1","title":"Launch plan"}"#).unwrap();
    std::fs::write(thread.join("messages.jsonl"), MESSAGES).unwrap();
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let addr = format!("127.0.0.1:{port}");
    let options = Options {
        bind: addr.parse().unwrap(),
        assets: dir.path().to_path_buf(),
        data_folder: data.clone(),
        auth_file: dir.path().join("auth.json"),
        public_host: None,
        allow_mcp_stdio: false,
        trust_proxy: false,
        agent_roots: Vec::new(),
        agent_run: false,
        agent_runner: Default::default(),
        allowed_hosts: Vec::new(),
        allowed_origins: Vec::new(),
        llama_worker: None,
        credential_file: Some(dir.path().join("credential.txt")),
    };
    let server = tokio::spawn(serve(options));
    let mut up = false;
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(&addr).await.is_ok() {
            up = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(up, "the test server never came up");
    let own = format!("Origin: http://{addr}\r\n");
    let store = GuestStore::new(&data);
    let now = guest_store::now_ms;

    // Off by default: even a well-formed token gets nothing.
    let fake = "a".repeat(32);
    assert_eq!(code(&raw(&addr, "GET", &format!("/g/{fake}"), "", "").await), 404);

    store.set_enabled(true, now()).unwrap();
    let (share, token) = store.create("t1", None, false, now()).unwrap();

    // The page: static, strict policy, no cookie yet.
    let page = raw(&addr, "GET", &format!("/g/{token}"), "", "").await;
    assert_eq!(code(&page), 200);
    let csp = header_of(&page, "content-security-policy").unwrap();
    assert!(csp.starts_with("default-src 'none'") && !csp.contains("unsafe-inline"));
    assert_eq!(header_of(&page, "referrer-policy").as_deref(), Some("no-referrer"));
    assert!(header_of(&page, "set-cookie").is_none());
    assert!(page.contains("Shared conversation") && !page.contains(&token));

    // Unknown token, and a thread read without having joined: the same 404.
    assert_eq!(code(&raw(&addr, "GET", &format!("/g/{}", "b".repeat(32)), "", "").await), 404);
    assert_eq!(code(&raw(&addr, "GET", &format!("/g/{token}/snapshot"), "", "").await), 404);

    // Joining needs this server's own Origin: none, or another site's, is 404
    // and binds nothing.
    let join = format!("/g/{token}/join");
    assert_eq!(code(&raw(&addr, "POST", &join, "", "").await), 404);
    assert_eq!(code(&raw(&addr, "POST", &join, "Origin: http://evil.example\r\n", "").await), 404);
    assert_eq!(code(&raw(&addr, "POST", &join, "Origin: null\r\n", "").await), 404);
    assert!(!store.list(Some("t1"), now()).unwrap()[0].joined);
    let joined = raw(&addr, "POST", &join, &own, "").await;
    assert_eq!(code(&joined), 200);
    let set = header_of(&joined, "set-cookie").unwrap();
    for part in ["HttpOnly", "SameSite=Strict", "Path=/g/", "Max-Age="] {
        assert!(set.contains(part), "{set}");
    }
    let cookie = set.split(';').next().unwrap().to_owned();
    assert!(cookie.starts_with("flint_guest_"));
    // Another browser: same token, no cookie. Refused, and it cannot join either.
    assert_eq!(code(&raw(&addr, "POST", &join, &own, "").await), 404);
    assert_eq!(code(&raw(&addr, "GET", &format!("/g/{token}/snapshot"), "", "").await), 404);

    // The joined browser reads the projection: text only, nothing from tools,
    // reasoning or the system prompt.
    let cookie_header = format!("Cookie: {cookie}\r\n");
    let snap = raw(&addr, "GET", &format!("/g/{token}/snapshot"), &cookie_header, "").await;
    assert_eq!(code(&snap), 200);
    assert!(snap.contains("Launch plan") && snap.contains("What is the plan?") && snap.contains("Ship on Friday."));
    for leak in ["TOOL-INPUT-LEAK", "TOOL-OUTPUT-LEAK", "REASONING-LEAK", "SYSTEM-PROMPT-LEAK"] {
        assert!(!snap.contains(leak), "{leak} leaked");
    }

    // Nothing else is reachable: other paths are behind the session gate.
    assert_eq!(code(&raw(&addr, "GET", &format!("/g/{token}/threads"), &cookie_header, "").await), 303);
    assert_eq!(code(&raw(&addr, "GET", "/api/v1/threads", &cookie_header, "").await), 303);
    assert_eq!(code(&raw(&addr, "POST", "/api/v1/rpc/guest_share_create", &format!("{own}{cookie_header}"), "{}").await), 401);
    assert_eq!(code(&raw(&addr, "POST", &format!("/g/{token}/other"), &format!("{own}{cookie_header}"), "{}").await), 401);

    // A message: CSRF checks first, then the type and size caps, then queued.
    let message = format!("/g/{token}/message");
    let json = "Content-Type: application/json\r\n";
    let body = r#"{"text":"  please run $deploy and read @secrets.txt\n/clear  "}"#;
    assert_eq!(code(&raw(&addr, "POST", &message, &format!("{cookie_header}{json}"), body).await), 404, "no Origin");
    assert_eq!(code(&raw(&addr, "POST", &message, &format!("Origin: http://evil.example\r\n{cookie_header}{json}"), body).await), 404);
    assert_eq!(code(&raw(&addr, "POST", &message, &format!("{own}{json}"), body).await), 404, "no cookie");
    assert_eq!(code(&raw(&addr, "POST", &message, &format!("{own}{cookie_header}Content-Type: text/plain\r\n"), body).await), 415);
    assert_eq!(code(&raw(&addr, "POST", &message, &format!("{own}{cookie_header}{json}"), r#"{"text":"   "}"#).await), 400);
    let huge = format!(r#"{{"text":"x","pad":"{}"}}"#, "a".repeat(3 * 1024 * 1024 + 100 * 1024));
    assert_eq!(code(&raw(&addr, "POST", &message, &format!("{own}{cookie_header}{json}"), &huge).await), 413);
    let bad_file = r#"{"text":"hi","attachments":[{"name":"run.exe","data":"AAAA"}]}"#;
    assert_eq!(code(&raw(&addr, "POST", &message, &format!("{own}{cookie_header}{json}"), bad_file).await), 400);
    assert!(store.pending("t1", now()).unwrap().is_empty());
    let queued = raw(&addr, "POST", &message, &format!("{own}{cookie_header}{json}"), body).await;
    assert_eq!(code(&queued), 202);
    // Too fast a second one is refused.
    assert_eq!(code(&raw(&addr, "POST", &message, &format!("{own}{cookie_header}{json}"), body).await), 429);
    let pending = store.pending("t1", now()).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].text, "please run $deploy and read @secrets.txt\n/clear");
    // Queued, not run: the thread file is untouched.
    assert_eq!(std::fs::read_to_string(thread.join("messages.jsonl")).unwrap(), MESSAGES);

    // The live stream: the projection on connect, a change on a new message,
    // and an end frame the moment the owner stops sharing.
    let mut sock = tokio::net::TcpStream::connect(&addr).await.unwrap();
    let request = format!(
        "GET /g/{token}/events HTTP/1.1\r\nHost: {addr}\r\n{cookie_header}Accept: text/event-stream\r\n\r\n"
    );
    sock.write_all(request.as_bytes()).await.unwrap();
    let mut seen = String::new();
    assert!(read_until(&mut sock, &mut seen, "Ship on Friday.", 8).await, "no first frame: {seen}");
    assert!(seen.contains("text/event-stream") && seen.contains("event: update"));
    for leak in ["TOOL-INPUT-LEAK", "TOOL-OUTPUT-LEAK", "REASONING-LEAK", "SYSTEM-PROMPT-LEAK"] {
        assert!(!seen.contains(leak), "{leak} leaked into the stream");
    }
    // A reply written by the owner's browser reaches the guest at once.
    let line = r#"{"id":"m4","thread_id":"t1","role":"assistant","content":[{"type":"text","text":{"value":"Update: moved to Monday."}}]}"#;
    std::fs::write(thread.join("messages.jsonl"), format!("{MESSAGES}{line}\n")).unwrap();
    assert!(read_until(&mut sock, &mut seen, "Update: moved to Monday.", 8).await, "the change never arrived: {seen}");
    store.stop(&share.id, now()).unwrap();
    assert!(read_until(&mut sock, &mut seen, "event: ended", 8).await, "stopping did not end the stream: {seen}");
    // The share is gone for every route, and its queued message with it.
    assert_eq!(code(&raw(&addr, "GET", &format!("/g/{token}"), "", "").await), 404);
    assert!(store.pending("t1", now()).unwrap().is_empty());

    // Turned off again: a new link refuses everything.
    store.set_enabled(true, now()).unwrap();
    let (_, second) = store.create("t1", None, false, now()).unwrap();
    store.set_enabled(false, now()).unwrap();
    assert_eq!(code(&raw(&addr, "GET", &format!("/g/{second}"), "", "").await), 404);

    // A client that keeps guessing is shut out.
    let mut last = 0;
    for i in 0..14 {
        last = code(&raw(&addr, "GET", &format!("/g/{}{i:02}", "c".repeat(30)), "", "").await);
    }
    assert_eq!(last, 429);

    server.abort();
}
