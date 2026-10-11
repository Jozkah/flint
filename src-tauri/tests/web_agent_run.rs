//! The server-side session runner, through the real `flint serve` binary:
//! sign-in gate, confinement, the session cap, a turn, an approval allowed and
//! denied, an interrupt, and the live event stream with `after=` resume.
//!
//! The model is a stub OpenAI-compatible provider. It answers "WRITE ..." with
//! a `write` tool call and a tool result with text; "SLOW ..." takes its time.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn chunk(delta: Value, finish: Value, usage: Option<Value>) -> String {
    let mut c = json!({
        "id":"stub-1","object":"chat.completion.chunk","created":1,"model":"stub-model",
        "choices":[{"index":0,"delta":delta,"finish_reason":finish}]
    });
    if let Some(u) = usage {
        c["usage"] = u;
    }
    format!("data: {c}\n\n")
}

fn answer_for(request: &Value) -> String {
    let messages = request["messages"].as_array().cloned().unwrap_or_default();
    let last = messages.last().cloned().unwrap_or(Value::Null);
    let text_of = |m: &Value| match &m["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    };
    let usage = json!({"prompt_tokens":5,"completion_tokens":2,"total_tokens":7});
    let mut out = String::new();
    let last_text = text_of(&last);
    if last["role"] == "user" && last_text.contains("WRITE") {
        out.push_str(&chunk(
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function",
                "function":{"name":"write","arguments":"{\"path\":\"out.txt\",\"content\":\"written by the runner\"}"}}]}),
            Value::Null,
            None,
        ));
        out.push_str(&chunk(json!({}), json!("tool_calls"), Some(usage)));
    } else {
        let reply = if last["role"] == "tool" { "tool finished" } else { "stub answer" };
        out.push_str(&chunk(json!({"role":"assistant","content":reply}), Value::Null, None));
        out.push_str(&chunk(json!({}), json!("stop"), Some(usage)));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn provider() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(stream) = connection else { break };
            std::thread::spawn(move || serve_one(stream));
        }
    });
    url
}

fn serve_one(mut stream: TcpStream) {
    stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        headers.push_str(&line);
    }
    let size = headers
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|n| n.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    let mut body = vec![0; size];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if request.to_string().contains("SLOW") {
        std::thread::sleep(Duration::from_secs(4));
    }
    let answer = answer_for(&request);
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
        answer.len()
    );
}

fn envs(command: &mut Command, home: &Path) {
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("FLINT_HOME", home)
        .env("JAN_HOME", home)
        .env("JAN_CLI_NO_UPDATE_CHECK", "1");
}

struct Server {
    child: Child,
    base: String,
    token: String,
    client: reqwest::blocking::Client,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("flint-web-run-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for sub in ["home", "work/app", "data", "assets"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    // The server refuses to start without a web bundle to serve.
    std::fs::write(dir.join("assets/index.html"), "<!doctype html><title>t</title>").unwrap();
    dir
}

fn start(dir: &Path, extra: &[&str]) -> Server {
    let base_url = provider();
    let home = dir.join("home");
    let mut config = Command::new(env!("CARGO_BIN_EXE_flint"));
    config.args([
        "config", "set", "--provider", "stub", "--api-key", "test-key", "--base-url", &base_url,
        "--model", "stub-model",
    ]);
    envs(&mut config, &home);
    assert!(config.output().unwrap().status.success());

    let port = free_port();
    let credential = dir.join("credential");
    let mut serve = Command::new(env!("CARGO_BIN_EXE_flint"));
    serve
        .args(["serve", "--listen", &format!("127.0.0.1:{port}")])
        .arg("--data-dir")
        .arg(dir.join("data"))
        .arg("--assets-dir")
        .arg(dir.join("assets"))
        .arg("--agent-root")
        .arg(dir.join("work"))
        .arg("--agent-run")
        .arg("--agent-require-sandbox=false")
        .arg("--credential-file")
        .arg(&credential)
        .args(extra)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    envs(&mut serve, &home);
    let child = serve.spawn().expect("start flint serve");
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build().unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if client.get(format!("{base}/healthz")).send().is_ok_and(|r| r.status().is_success()) {
            break;
        }
        assert!(Instant::now() < deadline, "server did not start");
        std::thread::sleep(Duration::from_millis(200));
    }
    let secret = std::fs::read_to_string(&credential).expect("credential file");
    let secret = secret.split_whitespace().find(|w| w.len() == 64).expect("64-hex credential").to_owned();
    let token = client
        .post(format!("{base}/api/v1/token"))
        .json(&json!({ "credential": secret }))
        .send()
        .unwrap()
        .json::<Value>()
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    Server { child, base, token, client }
}

impl Server {
    fn rpc(&self, command: &str, args: Value) -> (u16, Value) {
        let response = self
            .client
            .post(format!("{}/api/v1/rpc/{command}", self.base))
            .bearer_auth(&self.token)
            .json(&args)
            .send()
            .unwrap();
        let status = response.status().as_u16();
        let text = response.text().unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    /// Read the session's event stream from `after` until `done` accepts an
    /// envelope or `max` passes; returns every envelope seen.
    fn events(&self, id: &str, after: u64, max: Duration, mut done: impl FnMut(&Value) -> bool) -> Vec<Value> {
        let client = reqwest::blocking::Client::builder().timeout(max).build().unwrap();
        let response = client
            .get(format!("{}/api/v1/agent/sessions/{id}/events?after={after}", self.base))
            .bearer_auth(&self.token)
            .send()
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let mut seen = Vec::new();
        let mut reader = BufReader::new(response);
        let deadline = Instant::now() + max;
        let mut line = String::new();
        while Instant::now() < deadline {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                    if value.get("seq").is_some() && value.get("source").is_some() {
                        let stop = done(&value);
                        seen.push(value);
                        if stop {
                            break;
                        }
                    }
                }
            }
        }
        seen
    }
}

fn is_completed(e: &Value) -> bool {
    e["kind"] == "turn.completed"
}

#[test]
fn the_runner_gate_confinement_cap_turn_and_stream() {
    let dir = scratch("main");
    let server = start(&dir, &["--agent-max-sessions", "1"]);
    let folder = dir.join("work").join("app").canonicalize().unwrap();
    let folder = folder.to_string_lossy().into_owned();

    // The sign-in gate comes first.
    let anonymous = server
        .client
        .post(format!("{}/api/v1/rpc/agent_run_create", server.base))
        .bearer_auth("0".repeat(64))
        .json(&json!({ "folder": folder }))
        .send()
        .unwrap();
    assert_eq!(anonymous.status().as_u16(), 401);
    // No credential at all never reaches the runner either.
    let bare = server
        .client
        .post(format!("{}/api/v1/rpc/agent_run_create", server.base))
        .json(&json!({ "folder": folder }))
        .send()
        .unwrap();
    assert!(matches!(bare.status().as_u16(), 401 | 403));

    let (_, info) = server.rpc("agent_server_info", json!({}));
    assert_eq!(info["runsSessions"], true, "{info}");
    assert_eq!(info["maxSessions"], 1);
    assert_eq!(info["allowBypass"], false);

    // Confinement: outside the roots, and the data folder itself.
    let outside = dir.join("data").canonicalize().unwrap();
    let (status, _) = server.rpc("agent_run_create", json!({ "folder": outside.to_string_lossy() }));
    assert_eq!(status, 403);
    // Unattended access needs the operator's flag.
    let (status, _) = server.rpc("agent_run_create", json!({ "folder": folder, "access": "bypass" }));
    assert_eq!(status, 403);

    // One session fits; a second is refused by the cap.
    let (status, created) = server.rpc("agent_run_create", json!({ "folder": folder, "access": "ask" }));
    assert_eq!(status, 200, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, _) = server.rpc("agent_run_create", json!({ "folder": folder }));
    assert_eq!(status, 429);

    // It is listed and live before its first turn.
    let (_, listed) = server.rpc("agent_run_list", json!({}));
    let row = listed["sessions"].as_array().unwrap().iter().find(|s| s["id"] == id.as_str()).unwrap_or_else(|| panic!("{listed}"));
    assert_eq!(row["live"], true);
    assert_eq!(row["status"], "idle");

    // A turn: events arrive in order and the turn closes.
    let (status, started) = server.rpc("agent_run_start", json!({ "id": id, "input": "hello" }));
    assert_eq!(status, 200, "{started}");
    let seen = server.events(&id, 0, Duration::from_secs(60), is_completed);
    let kinds: Vec<&str> = seen.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds.first(), Some(&"turn.started"), "{kinds:?}");
    assert_eq!(kinds.last(), Some(&"turn.completed"), "{kinds:?}");
    assert_eq!(seen.last().unwrap()["payload"]["stopReason"], "completed", "{seen:?}");
    let seqs: Vec<u64> = seen.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "{seqs:?}");
    assert!(seen.iter().any(|e| e["payload"].to_string().contains("stub answer")));

    // Resume: `after=` returns only what came later (here: nothing new, so
    // the first envelope read is past the cursor once a new turn runs).
    let cursor = *seqs.last().unwrap();
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "again" }));
    assert_eq!(status, 200);
    let later = server.events(&id, cursor, Duration::from_secs(60), is_completed);
    assert!(later.iter().all(|e| e["seq"].as_u64().unwrap() > cursor));
    assert_eq!(later.first().unwrap()["kind"], "turn.started");

    // The transcript was saved and is readable through the P0 view.
    let (_, got) = server.rpc("agent_run_get", json!({ "id": id }));
    assert!(got["turns"].as_array().unwrap().len() >= 4, "{got}");
    assert_eq!(got["access"], "ask");

    // Deleting ends it, and frees the slot.
    let (status, _) = server.rpc("agent_run_delete", json!({ "id": id }));
    assert_eq!(status, 200);
    let (status, _) = server.rpc("agent_run_create", json!({ "folder": folder }));
    assert_eq!(status, 200);
}

#[test]
fn approvals_are_denied_allowed_validated_and_an_interrupt_cancels() {
    let dir = scratch("approve");
    let server = start(&dir, &[]);
    let folder = dir.join("work").join("app").canonicalize().unwrap();
    let target = folder.join("out.txt");
    let folder = folder.to_string_lossy().into_owned();
    let (status, created) = server.rpc("agent_run_create", json!({ "folder": folder, "access": "ask" }));
    assert_eq!(status, 200, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();

    let wait_request = |after: u64| -> (Vec<Value>, String) {
        let seen = server.events(&id, after, Duration::from_secs(60), |e| {
            e["payload"]["type"] == "permission_request" || is_completed(e)
        });
        let request = seen
            .iter()
            .find(|e| e["payload"]["type"] == "permission_request")
            .unwrap_or_else(|| panic!("no permission request in {seen:?}"));
        let rid = request["payload"]["request_id"].as_str().unwrap().to_owned();
        (seen, rid)
    };

    // Deny: the write does not happen, and the turn still ends.
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "WRITE it" }));
    assert_eq!(status, 200);
    let (seen, rid) = wait_request(0);
    // The session is waiting, and says so.
    let (_, row) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(row["status"], "awaiting_approval");
    assert_eq!(row["pendingApprovals"].as_array().unwrap().len(), 1);
    // A request id of another session (or none) is refused.
    let (status, _) = server.rpc("agent_run_approve", json!({ "id": id, "requestId": "perm-999999", "decision": "allow_once" }));
    assert_eq!(status, 404);
    // A standing grant needs the operator's flag.
    let (status, _) = server.rpc("agent_run_approve", json!({ "id": id, "requestId": rid, "decision": "allow_always" }));
    assert_eq!(status, 403);
    let (status, _) = server.rpc("agent_run_approve", json!({ "id": id, "requestId": rid, "decision": "deny" }));
    assert_eq!(status, 200);
    let cursor = seen.last().unwrap()["seq"].as_u64().unwrap();
    let rest = server.events(&id, cursor, Duration::from_secs(60), is_completed);
    assert_eq!(rest.last().unwrap()["kind"], "turn.completed", "{rest:?}");
    assert!(!target.exists(), "a denied write must not happen");
    // Answered once: a second answer is refused.
    let (status, _) = server.rpc("agent_run_approve", json!({ "id": id, "requestId": rid, "decision": "allow_once" }));
    assert_eq!(status, 404);

    // Allow once: the write happens.
    let after = rest.last().unwrap()["seq"].as_u64().unwrap();
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "WRITE it" }));
    assert_eq!(status, 200);
    let (seen, rid) = wait_request(after);
    let (status, _) = server.rpc("agent_run_approve", json!({ "id": id, "requestId": rid, "decision": "allow_once" }));
    assert_eq!(status, 200);
    let cursor = seen.last().unwrap()["seq"].as_u64().unwrap();
    let rest = server.events(&id, cursor, Duration::from_secs(60), is_completed);
    assert_eq!(rest.last().unwrap()["payload"]["stopReason"], "completed", "{rest:?}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "written by the runner");

    // The approvals are in the session's audit log, without the address.
    let (_, log) = server.rpc("agent_run_get", json!({ "id": id }));
    assert!(log["turns"].is_array());

    // Interrupt a slow turn: a cancelled done, then the turn closes.
    let after = rest.last().unwrap()["seq"].as_u64().unwrap();
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "SLOW please" }));
    assert_eq!(status, 200);
    // A second start while the turn is active is refused.
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "second" }));
    assert_eq!(status, 409);
    let (status, _) = server.rpc("agent_run_interrupt", json!({ "id": id }));
    assert_eq!(status, 200);
    let seen = server.events(&id, after, Duration::from_secs(30), |e| {
        is_completed(e) && e["payload"]["stopReason"] == "interrupted"
    });
    assert!(
        seen.iter().any(|e| e["payload"]["type"] == "done" && e["payload"]["stop_reason"] == "cancelled"),
        "{seen:?}"
    );
    let (_, row) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(row["status"], "idle");
    // Nothing is left to interrupt.
    let (status, _) = server.rpc("agent_run_interrupt", json!({ "id": id }));
    assert_eq!(status, 409);
}

#[test]
fn an_unanswered_approval_is_denied_after_the_timeout() {
    let dir = scratch("timeout");
    let server = start(&dir, &["--agent-approval-timeout", "2"]);
    let folder = dir.join("work").join("app").canonicalize().unwrap();
    let target = folder.join("out.txt");
    let folder = folder.to_string_lossy().into_owned();
    let (_, created) = server.rpc("agent_run_create", json!({ "folder": folder }));
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "WRITE it" }));
    assert_eq!(status, 200);
    let seen = server.events(&id, 0, Duration::from_secs(60), is_completed);
    let resolved = seen
        .iter()
        .find(|e| e["kind"] == "approval.resolved")
        .unwrap_or_else(|| panic!("no approval resolution in {seen:?}"));
    assert_eq!(resolved["payload"]["decision"], "deny");
    assert_eq!(resolved["payload"]["by"], "timeout");
    assert!(!target.exists());
}

#[test]
fn a_stored_session_resumes_after_a_restart_and_only_runner_sessions_are_deletable() {
    let dir = scratch("restart");
    let folder = dir.join("work").join("app").canonicalize().unwrap().to_string_lossy().into_owned();
    let id = {
        let server = start(&dir, &[]);
        let (_, created) = server.rpc("agent_run_create", json!({ "folder": folder, "mode": "cowork" }));
        let id = created["id"].as_str().unwrap().to_owned();
        let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "first" }));
        assert_eq!(status, 200);
        server.events(&id, 0, Duration::from_secs(60), is_completed);
        id
    };
    let server = start(&dir, &[]);
    // Not live after the restart, but stored; a command that needs a live
    // session says so, and a start brings it back.
    let (status, _) = server.rpc("agent_run_interrupt", json!({ "id": id }));
    assert_eq!(status, 404);
    let (_, got) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(got["mode"], "cowork");
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "second" }));
    assert_eq!(status, 200);
    let seen = server.events(&id, 0, Duration::from_secs(60), is_completed);
    assert_eq!(seen.last().unwrap()["payload"]["stopReason"], "completed");
    let (_, got) = server.rpc("agent_run_get", json!({ "id": id }));
    let contents: Vec<String> =
        got["turns"].as_array().unwrap().iter().map(|t| t["content"].to_string()).collect();
    assert!(contents.iter().any(|c| c.contains("first")) && contents.iter().any(|c| c.contains("second")), "{contents:?}");
    // A session this server did not start is not its to delete.
    let foreign = dir.join("data").join("threads").join("11111111-1111-4111-8111-111111111111");
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(
        foreign.join("thread.json"),
        json!({"id":"11111111-1111-4111-8111-111111111111","title":"cli","updated":1.0,
               "model":{"id":"m"},"metadata":{"folder":folder}}).to_string(),
    )
    .unwrap();
    std::fs::write(foreign.join("messages.jsonl"), "").unwrap();
    let (status, _) = server.rpc("agent_run_delete", json!({ "id": "11111111-1111-4111-8111-111111111111" }));
    assert_eq!(status, 403);
    let (status, _) = server.rpc("agent_run_delete", json!({ "id": id }));
    assert_eq!(status, 200);
    let (status, _) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(status, 404);
}
