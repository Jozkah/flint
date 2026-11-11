use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn only_the_listed_routes_are_public() {
    let public = [
        (Method::GET, "/healthz"),
        (Method::GET, "/readyz"),
        (Method::POST, "/api/v1/shutdown"),
        (Method::POST, "/api/v1/token"),
        (Method::GET, "/login"),
        (Method::POST, "/api/v1/session"),
        // Inbound webhooks: guarded by their own token and signature.
        (Method::POST, "/hooks/task-1/tok"),
        (Method::PUT, "/hooks/task-1/tok"),
        (Method::PATCH, "/hooks/task-1/tok"),
        // Guest links: their own share token, cookie and origin checks.
        (Method::GET, "/g/tok"),
        (Method::POST, "/g/tok/join"),
        (Method::GET, "/g/tok/snapshot"),
        (Method::GET, "/g/tok/events"),
        (Method::POST, "/g/tok/message"),
    ];
    for (method, path) in &public {
        assert_eq!(route_auth(method, path), Auth::Public, "{method} {path}");
    }
    // Same paths under another method, and everything else, sit behind the gate.
    for (method, path) in [
        (Method::POST, "/healthz"),
        (Method::POST, "/readyz"),
        (Method::GET, "/api/v1/shutdown"),
        (Method::GET, "/api/v1/token"),
        (Method::POST, "/login"),
        (Method::GET, "/api/v1/session"),
        (Method::DELETE, "/api/v1/session"),
        (Method::GET, "/api/v1/threads"),
        (Method::GET, "/"),
        (Method::GET, "/hooks/task-1/tok"),
        (Method::DELETE, "/hooks/task-1/tok"),
        (Method::POST, "/hook/task-1/tok"),
        (Method::POST, "/g/tok"),
        (Method::GET, "/g/tok/other"),
        (Method::DELETE, "/g/tok/message"),
    ] {
        assert_eq!(route_auth(&method, path), Auth::Session, "{method} {path}");
    }
}

/// One raw HTTP/1.1 request; returns the status code.
async fn status(addr: &str, method: &str, path: &str) -> u16 {
    let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nOrigin: http://{addr}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    sock.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), sock.read_to_end(&mut raw)).await;
    let head = String::from_utf8_lossy(&raw);
    head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// A webhook-style request: a body, no `Origin`, no cookie.
async fn hook_status(addr: &str, method: &str, path: &str, extra: &str, body: &str) -> u16 {
    let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), sock.read_to_end(&mut raw)).await;
    let head = String::from_utf8_lossy(&raw);
    head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0)
}

#[tokio::test]
async fn all_non_public_routes_require_auth() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "ok").unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    // A port picked up front: the server only reports its address through
    // the run file, which the test does not need.
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

    // No session: a page load is sent to the sign-in page, every other
    // request is refused.
    let behind_the_gate = [
        ("GET", "/"),
        ("GET", "/index.html"),
        ("GET", "/api/v1/threads"),
        ("GET", "/api/v1/threads/abc"),
        ("GET", "/api/v1/events"),
        ("GET", "/api/v1/session"),
        ("GET", "/api/v1/uploads/x"),
        ("GET", "/api/v1/hardware"),
        ("GET", "/api/v1/mcp/servers"),
        ("GET", "/api/v1/agent/sessions/s1/events"),
        ("GET", "/g/tok/other"),
        ("POST", "/api/v1/threads"),
        ("POST", "/api/v1/uploads"),
        ("POST", "/api/v1/uploads/parse"),
        ("POST", "/api/v1/rpc/list_threads"),
        ("POST", "/api/v1/provider/stream"),
        ("PUT", "/api/v1/threads/abc"),
        ("DELETE", "/api/v1/threads/abc"),
        ("DELETE", "/api/v1/sessions"),
        ("DELETE", "/api/v1/session"),
    ];
    for (method, path) in behind_the_gate {
        let code = status(&addr, method, path).await;
        let want: &[u16] = if method == "GET" { &[303] } else { &[401] };
        assert!(want.contains(&code), "{method} {path} answered {code} without a session");
    }

    // The public routes do not ask for one.
    assert_eq!(status(&addr, "GET", "/healthz").await, 200);
    assert_eq!(status(&addr, "GET", "/readyz").await, 200);
    assert_eq!(status(&addr, "GET", "/login").await, 200);
    // The shutdown route is public but needs its own token.
    assert_eq!(status(&addr, "POST", "/api/v1/shutdown").await, 403);

    // A webhook needs no session and no Origin, only its token (and signature).
    {
        use crate::core::schedule::spec::{fixtures::task, Schedule};
        use crate::core::schedule::store::Store;
        use crate::core::schedule::webhook::{Signature, SignatureEncoding, WebhookConfig};
        let token = "k".repeat(40);
        let mut hooked = task("hook-a");
        hooked.schedule = Schedule::Webhook;
        hooked.webhook = Some(WebhookConfig {
            token: token.clone(),
            signature: Some(Signature {
                header: "x-hub-signature-256".into(),
                secret: "shh".into(),
                encoding: SignatureEncoding::Hex,
                prefix: "sha256=".into(),
                has_secret: true,
            }),
            filters: vec![],
        });
        let store = Store::new(&data);
        store.save_task(hooked.clone()).unwrap();
        let mut off = hooked.clone();
        off.id = "hook-off".into();
        off.enabled = false;
        store.save_task(off).unwrap();
        // Unknown task, wrong token and a plain task all look the same.
        store.save_task(task("plain")).unwrap();
        for path in [
            "/hooks/nope/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".to_string(),
            format!("/hooks/hook-a/{}", "z".repeat(40)),
            format!("/hooks/plain/{token}"),
            "/hooks/hook-a".to_string(),
        ] {
            assert_eq!(hook_status(&addr, "POST", &path, "", "{}").await, 404, "{path}");
        }
        // Right token, but the signature is missing or wrong: 401, nothing starts.
        let ok_path = format!("/hooks/hook-a/{token}");
        assert_eq!(hook_status(&addr, "POST", &ok_path, "", "{}").await, 401);
        assert_eq!(hook_status(&addr, "PUT", &ok_path, "X-Hub-Signature-256: sha256=00\r\n", "{}").await, 401);
        // A task that is turned off is refused before its body is read.
        assert_eq!(hook_status(&addr, "POST", &format!("/hooks/hook-off/{token}"), "", "{}").await, 403);
        // The same path under GET is behind the gate.
        assert_eq!(status(&addr, "GET", &ok_path).await, 303);
    }

    // Readiness follows the data folder: gone means 503.
    std::fs::remove_dir_all(&data).unwrap();
    assert_eq!(status(&addr, "GET", "/readyz").await, 503);
    assert_eq!(status(&addr, "GET", "/healthz").await, 200);

    server.abort();
}

/// A test server on a fresh port; returns its address and task.
pub(super) async fn start_test_server(
    dir: &std::path::Path,
) -> (String, tokio::task::JoinHandle<impl Sized>) {
    std::fs::write(dir.join("index.html"), "ok").unwrap();
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let addr = format!("127.0.0.1:{port}");
    let options = Options {
        bind: addr.parse().unwrap(),
        assets: dir.to_path_buf(),
        data_folder: data,
        auth_file: dir.join("auth.json"),
        public_host: None,
        allow_mcp_stdio: false,
        trust_proxy: false,
        agent_roots: Vec::new(),
        agent_run: false,
        agent_runner: Default::default(),
        allowed_hosts: Vec::new(),
        allowed_origins: Vec::new(),
        llama_worker: None,
        credential_file: Some(dir.join("credential.txt")),
    };
    let server = tokio::spawn(serve(options));
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(&addr).await.is_ok() {
            return (addr, server);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("the test server never came up");
}

/// One raw HTTP/1.1 request; `headers` are extra header lines, each ending in
/// CRLF. Returns the status code and the raw response body.
pub(super) async fn send(addr: &str, method: &str, path: &str, headers: &str, body: &str) -> (u16, String) {
    let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "{method} {path} HTTP/1.1\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), sock.read_to_end(&mut raw)).await;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let code = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b.to_owned()).unwrap_or_default();
    (code, body)
}

/// Header lines (Host + bearer token) for a signed-in client of the server.
pub(super) async fn sign_in(addr: &str, dir: &std::path::Path) -> String {
    let mut credential = String::new();
    for _ in 0..50 {
        if let Ok(c) = std::fs::read_to_string(dir.join("credential.txt")) {
            if !c.trim().is_empty() {
                credential = c.trim().to_owned();
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let host = format!("Host: {addr}\r\nOrigin: http://{addr}\r\n");
    let body = format!("{{\"credential\":\"{credential}\"}}");
    let (code, reply) = send(addr, "POST", "/api/v1/token", &host, &body).await;
    assert_eq!(code, 200, "sign-in failed: {reply}");
    let token = reply
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .find_map(|v| v["token"].as_str().map(str::to_owned))
        .expect("token in the sign-in reply");
    format!("Host: {addr}\r\nAuthorization: Bearer {token}\r\n")
}

/// Two Host headers are refused whichever comes first: this server would
/// check one while a proxy in front could route by the other.
#[tokio::test]
async fn more_than_one_host_header_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (addr, server) = start_test_server(dir.path()).await;
    let good = format!("Host: {addr}\r\n");
    let evil = "Host: evil.example\r\n";
    assert_eq!(send(&addr, "GET", "/healthz", &good, "").await.0, 200);
    assert_eq!(send(&addr, "GET", "/healthz", &format!("{good}{evil}"), "").await.0, 400);
    assert_eq!(send(&addr, "GET", "/healthz", &format!("{evil}{good}"), "").await.0, 400);
    assert_eq!(send(&addr, "GET", "/healthz", &format!("{good}{good}"), "").await.0, 400);
    server.abort();
}

/// Ids Windows rewrites (`...` is the parent folder there, `abc.` is `abc`)
/// and device names are refused on every route, so nothing is deleted or
/// aliased; a real id still works.
#[tokio::test]
async fn dot_and_device_ids_are_refused_and_delete_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (addr, server) = start_test_server(dir.path()).await;
    let auth = sign_in(&addr, dir.path()).await;
    let data = dir.path().join("data");
    let thread = data.join("threads").join("keep");
    std::fs::create_dir_all(&thread).unwrap();
    std::fs::write(thread.join("thread.json"), r#"{"id":"keep","title":"t"}"#).unwrap();
    let assistant = data.join("assistants").join("jan");
    std::fs::create_dir_all(&assistant).unwrap();
    std::fs::write(assistant.join("assistant.json"), r#"{"id":"jan"}"#).unwrap();

    for (method, path) in [
        ("DELETE", "/api/v1/threads/...?permanent=true"),
        ("DELETE", "/api/v1/threads/keep.?permanent=true"),
        ("DELETE", "/api/v1/threads/NUL?permanent=true"),
        ("GET", "/api/v1/threads/.../messages"),
        ("GET", "/api/v1/threads/keep."),
        ("DELETE", "/api/v1/assistants/...."),
        ("DELETE", "/api/v1/assistants/jan."),
        ("DELETE", "/api/v1/assistants/CON"),
    ] {
        let (code, body) = send(&addr, method, path, &auth, "").await;
        assert_eq!(code, 400, "{method} {path} answered {code}: {body}");
    }
    assert!(thread.join("thread.json").exists(), "the thread folder was touched");
    assert!(assistant.join("assistant.json").exists(), "the assistants folder was touched");
    let (code, _) = send(&addr, "DELETE", "/api/v1/assistants/jan", &auth, "").await;
    assert_eq!(code, 204);
    assert!(!assistant.exists() && data.join("assistants").exists());
    server.abort();
}
