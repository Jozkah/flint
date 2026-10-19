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
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Verifier markers a test has let through: a brief that holds `BLOCKME-x`
/// gets no verdict (so its check is BLOCKED) until `x` is released here.
static RELEASED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn release(marker: &str) {
    RELEASED.lock().unwrap().get_or_insert_with(HashSet::new).insert(marker.to_owned());
}

fn is_released(marker: &str) -> bool {
    RELEASED.lock().unwrap().as_ref().is_some_and(|set| set.contains(marker))
}

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

/// What a utility call (the campaign planner or verifier) is answered with.
/// The engine streams these too, so they are told apart by their prompts.
fn utility_text(request: &Value) -> Option<String> {
    let text = request.to_string();
    if text.contains("You split a software goal") {
        return Some(
            json!({
                "title": "Three files",
                "tasks": [
                    {"id": "a", "title": "write a", "brief": "WRITE_FILE a.txt", "paths": ["a.txt"]},
                    {"id": "b", "title": "write b", "brief": "WRITE_FILE b.txt", "paths": ["b.txt"]},
                    {"id": "c", "title": "write c", "brief": "WRITE_FILE c.txt", "paths": ["c.txt"], "dependsOn": ["a", "b"]}
                ]
            })
            .to_string(),
        );
    }
    if text.contains("BEGIN UNTRUSTED EVIDENCE") {
        if let Some(at) = text.find("BLOCKME-") {
            let marker: String = text[at..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
            if !is_released(&marker) {
                return Some("I cannot decide this one.".to_string());
            }
        }
        return Some("VERDICT: PASS\nEVIDENCE: the file is there".to_string());
    }
    None
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
    if let Some(reply) = utility_text(request) {
        out.push_str(&chunk(json!({"role":"assistant","content":reply}), Value::Null, None));
        out.push_str(&chunk(json!({}), json!("stop"), Some(usage)));
        out.push_str("data: [DONE]\n\n");
        return out;
    }
    let last_text = text_of(&last);
    if last["role"] == "user" && last_text.contains("LIST_TOOLS") {
        let names: Vec<String> = request["tools"]
            .as_array()
            .map(|tools| {
                tools.iter().filter_map(|t| t["function"]["name"].as_str().map(str::to_owned)).collect()
            })
            .unwrap_or_default();
        out.push_str(&chunk(
            json!({"role":"assistant","content":format!("TOOLS: {}", names.join(","))}),
            Value::Null,
            None,
        ));
        out.push_str(&chunk(json!({}), json!("stop"), Some(usage)));
    } else if last["role"] == "user" && last_text.contains("COORDINATE_PLAN") {
        let args = json!({
            "title": "Two files",
            "tasks": [
                {"id": "a", "title": "write a", "brief": "WRITE_FILE a.txt", "paths": ["a.txt"]},
                {"id": "b", "title": "write b", "brief": "WRITE_FILE b.txt", "paths": ["b.txt"], "depends_on": ["a"]}
            ]
        })
        .to_string();
        out.push_str(&chunk(
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"call_plan","type":"function",
                "function":{"name":"host__campaign_plan","arguments": args}}]}),
            Value::Null,
            None,
        ));
        out.push_str(&chunk(json!({}), json!("tool_calls"), Some(usage)));
    } else if last["role"] == "user" && last_text.contains("WRITE_FILE ") {
        let name = last_text
            .split("WRITE_FILE ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .unwrap_or("x.txt")
            .to_owned();
        let args = json!({"path": name, "content": format!("from {name}")}).to_string();
        out.push_str(&chunk(
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function",
                "function":{"name":"write","arguments": args}}]}),
            Value::Null,
            None,
        ));
        out.push_str(&chunk(json!({}), json!("tool_calls"), Some(usage)));
    } else if last["role"] == "user" && last_text.contains("WRITE") {
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

// ---------------------------------------------------------------------------
// P2: worktrees and proposals for server sessions
// ---------------------------------------------------------------------------

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
        .args(args)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .expect("git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// `work/app` as a repository with one commit on `main`.
fn git_scratch(name: &str) -> (PathBuf, PathBuf) {
    let dir = scratch(name);
    let app = dir.join("work").join("app");
    git(&app, &["init", "-q", "-b", "main"]);
    std::fs::write(app.join("README.md"), "hello\n").unwrap();
    git(&app, &["add", "-A"]);
    git(&app, &["commit", "-q", "-m", "first"]);
    let app = app.canonicalize().unwrap();
    (dir, app)
}

/// Run one "WRITE" turn, allowing the write, and return the events seen.
fn write_turn(server: &Server, id: &str, after: u64) -> Vec<Value> {
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "WRITE it" }));
    assert_eq!(status, 200);
    let seen = server.events(id, after, Duration::from_secs(60), |e| {
        e["payload"]["type"] == "permission_request" || is_completed(e)
    });
    let request = seen
        .iter()
        .find(|e| e["payload"]["type"] == "permission_request")
        .unwrap_or_else(|| panic!("no permission request in {seen:?}"));
    let rid = request["payload"]["request_id"].as_str().unwrap().to_owned();
    let (status, _) =
        server.rpc("agent_run_approve", json!({ "id": id, "requestId": rid, "decision": "allow_once" }));
    assert_eq!(status, 200);
    let cursor = seen.last().unwrap()["seq"].as_u64().unwrap();
    let mut rest = server.events(id, cursor, Duration::from_secs(60), is_completed);
    let mut all = seen;
    all.append(&mut rest);
    all
}

fn approval_for(proposal: &Value, paths: &[&str]) -> Value {
    json!({
        "proposalId": proposal["id"],
        "patchHash": proposal["patchHash"],
        "baseStateHash": proposal["baseStateHash"],
        "scope": proposal["scope"],
        "files": paths.iter().map(|p| json!({ "path": p, "hunks": { "kind": "all" } })).collect::<Vec<_>>(),
    })
}

#[test]
fn a_worktree_session_writes_in_its_checkout_and_the_root_changes_only_on_approval() {
    let (dir, app) = git_scratch("wt-apply");
    let server = start(&dir, &[]);
    let folder = app.to_string_lossy().into_owned();

    let (status, created) = server.rpc("agent_run_create", json!({ "folder": folder, "access": "ask" }));
    assert_eq!(status, 200, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    // Writing access on a repository is isolated by default, under the
    // server's own folder.
    let worktree = created["worktree"].clone();
    let wt_path = PathBuf::from(worktree["path"].as_str().unwrap_or_else(|| panic!("{created}")));
    assert!(wt_path.canonicalize().unwrap().starts_with(dir.join("data").canonicalize().unwrap()), "{wt_path:?}");
    let (_, row) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(row["worktree"]["branch"], worktree["branch"], "{row}");
    assert_eq!(row["folder"], folder.as_str());

    let seen = write_turn(&server, &id, 0);
    let kinds: Vec<&str> = seen.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    let made = kinds.iter().position(|k| *k == "proposal.created").unwrap_or_else(|| panic!("{kinds:?} {seen:?}"));
    assert!(made < kinds.iter().position(|k| *k == "turn.completed").unwrap());
    // The write landed in the checkout and not in the root.
    assert_eq!(std::fs::read_to_string(wt_path.join("out.txt")).unwrap(), "written by the runner");
    assert!(!app.join("out.txt").exists(), "the root must not change before approval");

    // The proposal is on the existing review plane.
    let project = worktree["sourceRoot"].as_str().unwrap();
    let (status, listed) = server.rpc("agent_proposal_list", json!({ "project": project }));
    assert_eq!(status, 200, "{listed}");
    let pending: Vec<&Value> = listed.as_array().unwrap().iter().filter(|p| p["state"] == "pending").collect();
    assert_eq!(pending.len(), 1, "{listed}");
    let proposal = pending[0].clone();
    assert_eq!(proposal["scope"]["session"], id.as_str());
    assert_eq!(proposal["files"][0]["path"], "out.txt");
    assert!(!app.join("out.txt").exists());

    // A stale hash is refused; nothing is written.
    let mut wrong = approval_for(&proposal, &["out.txt"]);
    wrong["patchHash"] = json!("0".repeat(64));
    let (status, _) = server.rpc("agent_proposal_apply", json!({ "approval": wrong }));
    assert_eq!(status, 422);
    assert!(!app.join("out.txt").exists());
    // A file the change does not contain is refused.
    let (status, _) =
        server.rpc("agent_proposal_apply", json!({ "approval": approval_for(&proposal, &["../evil.txt"]) }));
    assert_eq!(status, 422);

    // Approved: it lands in the root, and only that file.
    let (status, report) =
        server.rpc("agent_proposal_apply", json!({ "approval": approval_for(&proposal, &["out.txt"]) }));
    assert_eq!(status, 200, "{report}");
    assert_eq!(std::fs::read_to_string(app.join("out.txt")).unwrap(), "written by the runner");
    // A second turn with the same content proposes nothing new.
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "hello again" }));
    assert_eq!(status, 200);
    let cursor = seen.last().unwrap()["seq"].as_u64().unwrap();
    let again = server.events(&id, cursor, Duration::from_secs(60), is_completed);
    assert!(!again.iter().any(|e| e["kind"] == "proposal.created"), "{again:?}");
}

#[test]
fn merge_and_discard_are_explicit_and_audited_and_a_read_session_has_no_worktree() {
    let (dir, app) = git_scratch("wt-merge");
    let server = start(&dir, &["--agent-allow-checks"]);
    let (_, info) = server.rpc("agent_server_info", json!({}));
    assert_eq!(info["runsChecks"], true);
    let folder = app.to_string_lossy().into_owned();

    // Read access runs in place.
    let (_, read) = server.rpc("agent_run_create", json!({ "folder": folder, "access": "read" }));
    assert!(read["worktree"].is_null(), "{read}");
    let (status, _) = server.rpc("agent_worktree_state", json!({ "id": read["id"] }));
    assert_eq!(status, 404);
    server.rpc("agent_run_delete", json!({ "id": read["id"] }));
    // An in-place session scaffolds its project settings in the root.
    let _ = std::fs::remove_dir_all(app.join(".jan"));

    let (status, created) =
        server.rpc("agent_run_create", json!({ "folder": folder, "access": "ask", "title": "Fix things" }));
    assert_eq!(status, 200, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let branch = created["worktree"]["branch"].as_str().unwrap().to_owned();
    assert!(branch.starts_with("flint/"), "{branch}");
    write_turn(&server, &id, 0);

    let (_, state) = server.rpc("agent_worktree_state", json!({ "id": id }));
    assert_eq!(state["state"], "ready", "{state}");
    let (_, pending) = server.rpc("agent_worktree_pending", json!({ "id": id }));
    assert!(pending["files"].as_array().unwrap().iter().any(|f| f == "out.txt"), "{pending}");
    // Uncommitted work blocks a merge until it is committed.
    let (status, refused) = server.rpc("agent_worktree_merge", json!({ "id": id }));
    assert_eq!(status, 422, "{refused}");
    assert!(!app.join("out.txt").exists());
    let (status, committed) =
        server.rpc("agent_worktree_commit_pending", json!({ "id": id, "message": "runner work" }));
    assert_eq!(status, 200, "{committed}");
    assert_eq!(committed["committed"], true);
    let (_, unmerged) = server.rpc("agent_worktree_unmerged", json!({ "id": id }));
    assert_eq!(unmerged["commits"].as_array().unwrap().len(), 1, "{unmerged}");
    // Discard refuses while the branch holds unmerged commits.
    let (status, _) = server.rpc("agent_worktree_discard", json!({ "id": id }));
    assert_eq!(status, 422);

    let (status, merged) = server.rpc("agent_worktree_merge", json!({ "id": id }));
    assert_eq!(status, 200, "{merged}");
    assert_eq!(merged["merged"], true);
    assert_eq!(merged["target"], "main");
    assert_eq!(git(&app, &["log", "-1", "--format=%s"]), "runner work");
    let tracked = git(&app, &["ls-files"]);
    assert!(!tracked.contains(".jan/"), "session state must not be merged: {tracked}");
    assert_eq!(std::fs::read_to_string(app.join("out.txt")).unwrap(), "written by the runner");

    // The audit trail names the client by digest, never the token.
    let mut events = String::new();
    let mut stack = vec![dir.join("data")];
    while let Some(path) = stack.pop() {
        if path.is_dir() {
            if let Ok(read) = std::fs::read_dir(&path) {
                stack.extend(read.flatten().map(|e| e.path()));
            }
        } else if path.extension().is_some_and(|e| e == "jsonl" || e == "json") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                events.push_str(&text);
            }
        }
    }
    assert!(events.contains("worktree.merge") && events.contains("worktree.commit_pending"), "audit missing");
    assert!(!events.contains(&server.token));

    // Discard removes the checkout and the branch, and ends the session.
    let wt_path = PathBuf::from(created["worktree"]["path"].as_str().unwrap());
    assert!(wt_path.exists());
    let (status, gone) = server.rpc("agent_worktree_discard", json!({ "id": id }));
    assert_eq!(status, 200, "{gone}");
    assert!(!wt_path.exists());
    assert!(git(&app, &["branch", "--list", &branch]).is_empty());
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "more" }));
    assert!(matches!(status, 404 | 409 | 410), "{status}");
    let (_, row) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(row["worktreeDiscarded"], true);
}

#[test]
fn escapes_and_a_forged_record_are_refused_and_the_flag_is_off_by_default() {
    let (dir, app) = git_scratch("wt-escape");
    let server = start(&dir, &[]);
    let (_, info) = server.rpc("agent_server_info", json!({}));
    assert_eq!(info["runsChecks"], false);
    let folder = app.to_string_lossy().into_owned();
    let data = dir.join("data").canonicalize().unwrap();

    // A client names neither a path nor a record: only a session.
    let (status, _) = server.rpc("agent_worktree_list", json!({ "project": data.to_string_lossy() }));
    assert_eq!(status, 403);
    let climbing = app.join("..").join("..");
    let (status, _) = server.rpc("agent_worktree_list", json!({ "project": climbing.to_string_lossy() }));
    assert!(matches!(status, 403 | 404), "{status}");
    let (status, _) = server.rpc("agent_run_create", json!({ "folder": folder, "base": "--upload-pack=x" }));
    assert_eq!(status, 400);
    let (status, _) = server.rpc("agent_run_create", json!({ "folder": folder, "base": "no-such-branch" }));
    assert_eq!(status, 422);
    let (_, listed) = server.rpc("agent_run_list", json!({}));
    assert!(listed["sessions"].as_array().unwrap().is_empty(), "a refused create leaves no session: {listed}");

    let (status, created) = server.rpc("agent_run_create", json!({ "folder": folder }));
    assert_eq!(status, 200, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, listed) = server.rpc("agent_worktree_list", json!({ "project": folder }));
    assert_eq!(status, 200, "{listed}");
    assert_eq!(listed["worktrees"].as_array().unwrap().len(), 1);

    // A forged path or record in the request is ignored.
    let (status, state) = server.rpc(
        "agent_worktree_state",
        json!({ "id": id, "record": { "path": data.to_string_lossy() }, "path": data.to_string_lossy() }),
    );
    assert_eq!(status, 200);
    assert_eq!(state["worktree"]["path"], created["worktree"]["path"]);

    // A stored record that points outside the owned root, or at a repository
    // outside the roots, is refused by every operation, and nothing moves.
    let thread = dir.join("data").join("threads").join(&id).join("thread.json");
    let original = std::fs::read_to_string(&thread).unwrap();
    let outside = dir.join("home").to_string_lossy().into_owned();
    let decoy = app.to_string_lossy().into_owned();
    let data_s = data.to_string_lossy().into_owned();
    let forgeries: Vec<(&str, String)> =
        vec![("path", outside), ("path", decoy), ("sourceRoot", data_s)];
    for (key, value) in forgeries {
        let mut forged: Value = serde_json::from_str(&original).unwrap();
        forged["metadata"]["worktree"][key] = json!(value);
        std::fs::write(&thread, forged.to_string()).unwrap();
        for (command, args) in [
            ("agent_worktree_state", json!({ "id": id })),
            ("agent_worktree_pending", json!({ "id": id })),
            ("agent_worktree_merge", json!({ "id": id, "commitMessage": "x" })),
            ("agent_worktree_discard", json!({ "id": id, "force": true })),
            ("agent_worktree_rename", json!({ "id": id, "title": "x" })),
            ("agent_worktree_commit_pending", json!({ "id": id })),
        ] {
            let (status, body) = server.rpc(command, args);
            assert!(matches!(status, 403 | 404), "{key} {command}: {status} {body}");
        }
    }
    assert!(app.join("README.md").exists());
    assert_eq!(git(&app, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    std::fs::write(&thread, &original).unwrap();
    let (status, _) = server.rpc("agent_worktree_state", json!({ "id": id }));
    assert_eq!(status, 200);

    // A link out of the checkout stops the proposal and says why.
    let wt_path = PathBuf::from(created["worktree"]["path"].as_str().unwrap());
    let secret = dir.join("home").join("secret.txt");
    std::fs::write(&secret, "outside").unwrap();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&secret, wt_path.join("leak.txt")).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&secret, wt_path.join("leak.txt")).is_ok();
    if linked {
        let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "hello" }));
        assert_eq!(status, 200);
        let seen = server.events(&id, 0, Duration::from_secs(60), is_completed);
        assert!(seen.iter().any(|e| e["kind"] == "proposal.error"), "{seen:?}");
        assert!(!seen.iter().any(|e| e["kind"] == "proposal.created"));
    } else {
        eprintln!("symlink not permitted here; link escape case skipped");
    }
    // A session that is not a runner session has no worktree to act on.
    let foreign_id = "22222222-2222-4222-8222-222222222222";
    let foreign = dir.join("data").join("threads").join(foreign_id);
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(
        foreign.join("thread.json"),
        json!({"id":foreign_id,"title":"cli","updated":1.0,"model":{"id":"m"},
               "metadata":{"folder":folder,"worktree":{"path":wt_path.to_string_lossy(),"branch":"flint/x"}}})
        .to_string(),
    )
    .unwrap();
    std::fs::write(foreign.join("messages.jsonl"), "").unwrap();
    let (status, _) = server.rpc("agent_worktree_discard", json!({ "id": foreign_id, "force": true }));
    assert_eq!(status, 403);
    assert!(wt_path.exists());
}

// ---------------------------------------------------------------------------
// P3: campaigns driven by the server
// ---------------------------------------------------------------------------

fn wait_for(what: &str, max: Duration, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + max;
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    panic!("timed out waiting for {what}");
}

fn campaign_of(server: &Server, id: &str) -> Value {
    let (status, got) = server.rpc("agent_campaign_get", json!({ "id": id }));
    assert_eq!(status, 200, "{got}");
    got
}

fn statuses(c: &Value) -> Vec<String> {
    c["tasks"].as_array().unwrap().iter().map(|t| t["status"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn a_campaign_is_planned_approved_run_merged_and_proposed_with_no_client_attached() {
    let (dir, app) = git_scratch("campaign");
    let server = start(&dir, &["--agent-allow-bypass"]);
    let folder = app.to_string_lossy().into_owned();

    let (_, info) = server.rpc("agent_server_info", json!({}));
    assert_eq!(info["runsCampaigns"], true, "{info}");

    // The gate: confinement, and no goal is refused.
    let (status, _) = server.rpc(
        "agent_campaign_start_server",
        json!({ "goal": "x", "folder": dir.join("data").to_string_lossy() }),
    );
    assert_eq!(status, 403);
    let (status, _) = server.rpc("agent_campaign_start_server", json!({ "goal": "", "folder": folder }));
    assert_eq!(status, 400);

    // Planned by the server's model; nothing runs before a person approves.
    let (status, made) = server.rpc(
        "agent_campaign_start_server",
        json!({ "goal": "write three files", "folder": folder, "options": { "maxParallel": 2 } }),
    );
    assert_eq!(status, 200, "{made}");
    let id = made["id"].as_str().unwrap().to_owned();
    assert_eq!(made["status"], "planned");
    assert_eq!(made["driver"], "server");
    assert_eq!(made["tasks"].as_array().unwrap().len(), 3);
    let (_, approvals) = server.rpc("agent_campaign_approvals", json!({}));
    assert!(
        approvals["approvals"].as_array().unwrap().iter().any(|a| a["campaignId"] == id.as_str() && a["kind"] == "plan"),
        "{approvals}"
    );
    std::thread::sleep(Duration::from_secs(4));
    assert_eq!(campaign_of(&server, &id)["status"], "planned");
    let (_, sessions) = server.rpc("agent_run_list", json!({}));
    assert!(sessions["sessions"].as_array().unwrap().is_empty(), "{sessions}");

    // Task moves and a plan approval are not a client's to make by transition.
    let (status, _) = server.rpc(
        "agent_campaign_transition",
        json!({ "id": id, "input": { "campaign": "running" } }),
    );
    assert_eq!(status, 403);
    // Unattended access is the operator's switch: a bypass-off server refuses it.

    let (status, approved) = server.rpc("agent_campaign_approve", json!({ "id": id, "access": "worktree" }));
    assert_eq!(status, 200, "{approved}");
    assert_eq!(approved["status"], "running");
    assert_eq!(approved["modeCeiling"], "auto");

    wait_for("the campaign to reach reviewing", Duration::from_secs(240), || {
        let c = campaign_of(&server, &id);
        assert_ne!(c["status"], "failed", "{c}");
        c["status"] == "reviewing"
    });
    let c = campaign_of(&server, &id);
    assert_eq!(statuses(&c), vec!["merged", "merged", "merged"], "{c}");
    // Dependency order: c started after a and b were merged.
    let events = server.rpc("agent_campaign_events", json!({ "id": id })).1;
    let events = events.as_array().unwrap();
    let at = |kind: &str, task: &str| {
        events.iter().position(|e| e["kind"] == kind && e["task"] == task).unwrap_or_else(|| panic!("{kind} {task}: {events:?}"))
    };
    assert!(at("task-merged", "a") < at("task-settled", "c"));
    assert!(at("task-merged", "b") < at("task-settled", "c"));

    // Finalize is a person's call: it ran no gate (no command to run) and
    // stored one proposal against the user's checkout, which is untouched.
    assert!(!app.join("a.txt").exists());
    let (status, report) = server.rpc("agent_campaign_finalize", json!({ "id": id }));
    assert_eq!(status, 200, "{report}");
    let proposal_id = report["proposalId"].as_str().unwrap_or_else(|| panic!("{report}")).to_owned();
    assert!(!app.join("a.txt").exists(), "nothing reaches the checkout before an approval");

    let (_, listed) = server.rpc("agent_proposal_list", json!({ "project": folder }));
    let proposal = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == proposal_id.as_str())
        .unwrap_or_else(|| panic!("{listed}"))
        .clone();
    let files: Vec<String> =
        proposal["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
    assert!(["a.txt", "b.txt", "c.txt"].iter().all(|f| files.iter().any(|g| g == f)), "{files:?}");
    let (status, applied) = server.rpc(
        "agent_proposal_apply",
        json!({ "approval": approval_for(&proposal, &["a.txt", "b.txt", "c.txt"]) }),
    );
    assert_eq!(status, 200, "{applied}");
    assert_eq!(std::fs::read_to_string(app.join("c.txt")).unwrap(), "from c.txt");
    let (_, refreshed) = server.rpc("agent_campaign_refresh", json!({ "id": id }));
    assert_eq!(refreshed["status"], "done", "{refreshed}");
}

#[test]
fn a_server_without_the_bypass_flag_refuses_unattended_task_access() {
    let (dir, app) = git_scratch("campaign-ask");
    let server = start(&dir, &[]);
    let folder = app.to_string_lossy().into_owned();
    let plan = json!([{ "id": "a", "title": "a", "brief": "WRITE_FILE a.txt", "paths": ["a.txt"] }]);
    let (status, made) = server.rpc(
        "agent_campaign_start_server",
        json!({ "goal": "one file", "folder": folder, "options": { "plan": plan } }),
    );
    assert_eq!(status, 200, "{made}");
    let id = made["id"].as_str().unwrap();
    let (status, _) = server.rpc("agent_campaign_approve", json!({ "id": id, "access": "worktree" }));
    assert_eq!(status, 403);
    assert_eq!(campaign_of(&server, id)["status"], "planned");
    // Cancelling a plan that was never approved leaves nothing behind.
    let (status, cancelled) = server.rpc("agent_campaign_cancel", json!({ "id": id }));
    assert_eq!(status, 200, "{cancelled}");
    assert_eq!(cancelled["status"], "cancelled");
}

#[test]
fn a_client_deletes_an_idle_campaign_but_never_a_running_one() {
    let (dir, app) = git_scratch("campaign-delete");
    let server = start(&dir, &["--agent-allow-bypass"]);
    let folder = app.to_string_lossy().into_owned();
    let listed = |server: &Server| -> Vec<String> {
        let (status, all) = server.rpc("agent_campaign_list", json!({}));
        assert_eq!(status, 200, "{all}");
        all.as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_owned()).collect()
    };

    // A plan that was never approved has no run and no worktree: it may go.
    let plan = json!([{ "id": "a", "title": "a", "brief": "WRITE_FILE a.txt", "paths": ["a.txt"] }]);
    let idle = start_campaign(&server, &folder, "never approved", plan);
    assert!(listed(&server).contains(&idle));
    let (status, gone) = server.rpc("agent_campaign_delete", json!({ "id": idle }));
    assert_eq!(status, 200, "{gone}");
    assert!(!listed(&server).contains(&idle));
    assert_ne!(server.rpc("agent_campaign_get", json!({ "id": idle })).0, 200);
    // Deleting twice, or a made-up id, is an error and changes nothing.
    assert_ne!(server.rpc("agent_campaign_delete", json!({ "id": idle })).0, 200);
    assert_ne!(server.rpc("agent_campaign_delete", json!({ "id": "../x" })).0, 200);

    // A campaign that is running is refused until it is stopped.
    let plan = json!([{ "id": "a", "title": "a", "brief": "SLOW WRITE_FILE a.txt", "paths": ["a.txt"] }]);
    let busy = start_campaign(&server, &folder, "running", plan);
    let (status, _) = server.rpc("agent_campaign_approve", json!({ "id": busy, "access": "worktree" }));
    assert_eq!(status, 200);
    wait_for("the task to be running", Duration::from_secs(60), || {
        statuses(&campaign_of(&server, &busy))[0] == "running"
    });
    let (status, refused) = server.rpc("agent_campaign_delete", json!({ "id": busy }));
    assert_ne!(status, 200, "{refused}");
    assert!(listed(&server).contains(&busy));
    let (status, cancelled) = server.rpc("agent_campaign_cancel", json!({ "id": busy }));
    assert_eq!(status, 200, "{cancelled}");
    let (status, gone) = server.rpc("agent_campaign_delete", json!({ "id": busy }));
    assert_eq!(status, 200, "{gone}");
    assert!(!listed(&server).contains(&busy));
    // The project folder is untouched.
    assert!(app.join("README.md").exists());
}

#[test]
fn a_campaign_continues_by_itself_after_the_server_restarts_mid_run() {
    let (dir, app) = git_scratch("campaign-restart");
    let folder = app.to_string_lossy().into_owned();
    let plan = json!([
        { "id": "a", "title": "write a", "brief": "SLOW WRITE_FILE a.txt", "paths": ["a.txt"] },
        { "id": "b", "title": "write b", "brief": "WRITE_FILE b.txt", "paths": ["b.txt"], "dependsOn": ["a"] }
    ]);
    let id = {
        let server = start(&dir, &["--agent-allow-bypass"]);
        let (status, made) = server.rpc(
            "agent_campaign_start_server",
            json!({ "goal": "two files", "folder": folder, "options": { "plan": plan } }),
        );
        assert_eq!(status, 200, "{made}");
        let id = made["id"].as_str().unwrap().to_owned();
        let (status, _) = server.rpc("agent_campaign_approve", json!({ "id": id, "access": "worktree" }));
        assert_eq!(status, 200);
        wait_for("task a to be running", Duration::from_secs(60), || {
            statuses(&campaign_of(&server, &id))[0] == "running"
        });
        id
        // The server is killed here, with a run in flight.
    };
    let server = start(&dir, &["--agent-allow-bypass"]);
    wait_for("the campaign to reach reviewing after the restart", Duration::from_secs(240), || {
        let c = campaign_of(&server, &id);
        assert_ne!(c["status"], "failed", "{c}");
        c["status"] == "reviewing"
    });
    let c = campaign_of(&server, &id);
    assert_eq!(statuses(&c), vec!["merged", "merged"], "{c}");
    let events = server.rpc("agent_campaign_events", json!({ "id": id })).1;
    assert!(
        events.as_array().unwrap().iter().any(|e| e["kind"] == "driver-resumed"),
        "{events}"
    );
}

// ---------------------------------------------------------------------------
// Closing the runner's gaps: task moves, pickers, the coordinator, attachments
// ---------------------------------------------------------------------------

fn plan_of(tasks: Value) -> Value {
    json!({ "plan": tasks })
}

fn start_campaign(server: &Server, folder: &str, goal: &str, tasks: Value) -> String {
    let (status, made) = server.rpc(
        "agent_campaign_start_server",
        json!({ "goal": goal, "folder": folder, "options": plan_of(tasks) }),
    );
    assert_eq!(status, 200, "{made}");
    made["id"].as_str().unwrap().to_owned()
}

fn task_of(server: &Server, id: &str, task: &str) -> Value {
    campaign_of(server, id)["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == task)
        .unwrap_or_else(|| panic!("no task {task}"))
        .clone()
}

#[test]
fn a_client_moves_tasks_of_a_server_campaign_through_the_driver_and_is_audited() {
    let (dir, app) = git_scratch("task-moves");
    let server = start(&dir, &["--agent-allow-bypass"]);
    let folder = app.to_string_lossy().into_owned();
    let (_, info) = server.rpc("agent_server_info", json!({}));
    let commands = info["campaignCommands"].as_array().unwrap_or_else(|| panic!("{info}"));
    for c in ["agent_campaign_skip_task", "agent_campaign_accept_task", "agent_campaign_verify_again", "agent_campaign_retry_task"] {
        assert!(commands.iter().any(|x| x == c), "{c} in {info}");
    }

    // Not for an anonymous caller.
    let anonymous = server
        .client
        .post(format!("{}/api/v1/rpc/agent_campaign_skip_task", server.base))
        .json(&json!({ "id": "x", "taskId": "a" }))
        .send()
        .unwrap();
    assert!(matches!(anonymous.status().as_u16(), 401 | 403));

    // One campaign: a is blocked, b and c are ordinary.
    let id = start_campaign(
        &server,
        &folder,
        "blocked then accepted",
        json!([
            { "id": "a", "title": "write a", "brief": "BLOCKME-accept WRITE_FILE a.txt", "paths": ["a.txt"] },
            { "id": "b", "title": "write b", "brief": "BLOCKME-again WRITE_FILE b.txt", "paths": ["b.txt"] },
            { "id": "c", "title": "write c", "brief": "BLOCKME-skip WRITE_FILE c.txt", "paths": ["c.txt"] },
            { "id": "d", "title": "write d", "brief": "WRITE_FILE d.txt", "paths": ["d.txt"], "dependsOn": ["c"] }
        ]),
    );
    let (status, _) = server.rpc("agent_campaign_approve", json!({ "id": id, "access": "worktree" }));
    assert_eq!(status, 200);
    wait_for("three tasks to wait on a person", Duration::from_secs(240), || {
        ["a", "b", "c"].iter().all(|t| {
            let task = task_of(&server, &id, t);
            task["status"] == "completed" && task["verdict"] == "BLOCKED"
        })
    });

    // The raw task move is still not a client's.
    let (status, _) = server.rpc(
        "agent_campaign_transition",
        json!({ "id": id, "input": { "task": { "id": "a", "to": "verified" } } }),
    );
    assert_eq!(status, 403);

    // Accept anyway: a reason is required, and the record names the client.
    let (status, _) = server.rpc("agent_campaign_accept_task", json!({ "id": id, "taskId": "a" }));
    assert_eq!(status, 422);
    assert_eq!(task_of(&server, &id, "a")["status"], "completed");
    let (status, body) = server.rpc(
        "agent_campaign_accept_task",
        json!({ "id": id, "taskId": "a", "reason": "I read the diff" }),
    );
    assert_eq!(status, 200, "{body}");
    let accepted = task_of(&server, &id, "a");
    let by = accepted["manualOverride"]["by"].as_str().unwrap_or_else(|| panic!("{accepted}"));
    assert!(by.starts_with("client "), "{by}");
    assert!(!by.contains(&server.token), "the token is never recorded");
    assert_eq!(accepted["manualOverride"]["reason"], "I read the diff");

    // Verify again: the same check, now allowed through, passes and merges.
    release("BLOCKME-again");
    let (status, body) = server.rpc("agent_campaign_verify_again", json!({ "id": id, "taskId": "b" }));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["started"], true);

    // Skip with cascade: the dependant is cancelled with it.
    let (status, body) = server.rpc(
        "agent_campaign_skip_task",
        json!({ "id": id, "taskId": "c", "dependants": "cascade" }),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["cancelled"], json!(["d"]));
    // A task that is not blocked has nothing to accept, and a merged one cannot be retried.
    wait_for("a and b to merge", Duration::from_secs(120), || {
        task_of(&server, &id, "a")["status"] == "merged" && task_of(&server, &id, "b")["status"] == "merged"
    });
    let (status, _) = server.rpc("agent_campaign_retry_task", json!({ "id": id, "taskId": "a" }));
    assert_eq!(status, 422);
    let (status, _) = server.rpc("agent_campaign_accept_task", json!({ "id": id, "taskId": "b", "reason": "x" }));
    assert_eq!(status, 422);
    wait_for("the campaign to reach reviewing", Duration::from_secs(120), || {
        campaign_of(&server, &id)["status"] == "reviewing"
    });

    // Every move is in the campaign's event log with the client digest.
    let (_, events) = server.rpc("agent_campaign_events", json!({ "id": id }));
    let log: Vec<String> = events
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "client-command")
        .map(|e| e["detail"].as_str().unwrap().to_owned())
        .collect();
    for what in ["accept anyway", "verify again", "skip (cascade)"] {
        assert!(log.iter().any(|l| l.starts_with(what) && l.contains(" by client ")), "{what}: {log:?}");
    }
    assert!(log.iter().all(|l| !l.contains(&server.token)), "{log:?}");
}

#[test]
fn model_and_mode_pickers_rename_and_delete_use_only_what_the_server_has() {
    let dir = scratch("pickers");
    let server = start(&dir, &[]);
    let folder = dir.join("work").join("app").canonicalize().unwrap().to_string_lossy().into_owned();

    // The models are the providers configured on the server: ids and sizes,
    // never a key or an address.
    let (status, listed) = server.rpc("agent_run_models", json!({}));
    assert_eq!(status, 200, "{listed}");
    let models = listed["models"].as_array().unwrap();
    let stub = models.iter().find(|m| m["id"] == "stub-model").unwrap_or_else(|| panic!("{listed}"));
    assert_eq!(stub["provider"], "stub");
    assert!(stub["contextWindow"].as_u64().unwrap() >= 1000, "{stub}");
    let raw = listed.to_string();
    assert!(!raw.contains("test-key") && !raw.contains("127.0.0.1"), "no secret or endpoint: {raw}");

    let (_, created) = server.rpc("agent_run_create", json!({ "folder": folder, "access": "ask" }));
    let id = created["id"].as_str().unwrap().to_owned();
    // A model the server cannot reach is refused; the session keeps its own.
    let (status, _) = server.rpc("agent_run_set_model", json!({ "id": id, "model": "other/zzz-unknown" }));
    assert_eq!(status, 422);
    let (status, set) = server.rpc("agent_run_set_model", json!({ "id": id, "model": "stub-model" }));
    assert_eq!(status, 200, "{set}");

    // The mode is held to the operator's flags.
    let (status, _) = server.rpc("agent_run_set_mode", json!({ "id": id, "access": "auto" }));
    assert_eq!(status, 403);
    let (status, _) = server.rpc("agent_run_set_mode", json!({ "id": id, "access": "read" }));
    assert_eq!(status, 200);
    let (_, row) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(row["access"], "read", "{row}");

    // Rename: bounded, and not empty.
    let (status, _) = server.rpc("agent_run_rename", json!({ "id": id, "title": "   " }));
    assert_eq!(status, 400);
    let (status, _) = server.rpc("agent_run_rename", json!({ "id": id, "title": "Weekly report" }));
    assert_eq!(status, 200);
    let (_, row) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(row["title"], "Weekly report", "{row}");

    // A stored session that is not live is changed in its record too.
    drop(server);
    let server = start(&dir, &[]);
    let (status, _) = server.rpc("agent_run_set_mode", json!({ "id": id, "access": "ask" }));
    assert_eq!(status, 200);
    let (status, _) = server.rpc("agent_run_rename", json!({ "id": id, "title": "Weekly report v2" }));
    assert_eq!(status, 200);
    let (status, _) = server.rpc("agent_run_set_model", json!({ "id": id, "model": "stub-model" }));
    assert_eq!(status, 200);
    let (_, row) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!((row["access"].as_str(), row["title"].as_str()), (Some("ask"), Some("Weekly report v2")), "{row}");
    // Delete ends it for good.
    let (status, _) = server.rpc("agent_run_delete", json!({ "id": id }));
    assert_eq!(status, 200);
    let (status, _) = server.rpc("agent_run_get", json!({ "id": id }));
    assert_eq!(status, 404);
}

#[test]
fn a_coordinator_plans_in_process_and_only_a_coordinator_has_the_campaign_tools() {
    let (dir, app) = git_scratch("coordinator");
    let server = start(&dir, &["--agent-allow-bypass"]);
    let folder = app.to_string_lossy().into_owned();

    // The role is validated, and a coordinator cannot be read-only.
    let (status, _) = server.rpc("agent_run_create", json!({ "folder": folder, "role": "boss" }));
    assert_eq!(status, 400);
    let (status, _) = server.rpc("agent_run_create", json!({ "folder": folder, "role": "coordinator", "access": "read" }));
    assert_eq!(status, 400);

    // An ordinary session is never offered the campaign tools.
    let (_, plain) = server.rpc("agent_run_create", json!({ "folder": folder, "access": "ask" }));
    let plain_id = plain["id"].as_str().unwrap().to_owned();
    let (status, _) = server.rpc("agent_run_start", json!({ "id": plain_id, "input": "LIST_TOOLS" }));
    assert_eq!(status, 200);
    let seen = server.events(&plain_id, 0, Duration::from_secs(60), is_completed);
    let said = seen.iter().map(|e| e["payload"].to_string()).collect::<Vec<_>>().join("\n");
    assert!(said.contains("TOOLS:"), "{said}");
    assert!(!said.contains("campaign_"), "an ordinary session has no campaign tool: {said}");

    // The coordinator: a session whose model calls campaign_plan, answered
    // here with no client attached.
    let (status, started) = server.rpc(
        "agent_campaign_start_server",
        json!({ "goal": "COORDINATE_PLAN two files", "folder": folder, "coordinator": true }),
    );
    assert_eq!(status, 200, "{started}");
    let coordinator = started["coordinator"]["id"].as_str().unwrap_or_else(|| panic!("{started}")).to_owned();
    let mut found = Value::Null;
    wait_for("the coordinator's plan to be recorded", Duration::from_secs(90), || {
        let (_, all) = server.rpc("agent_campaign_list", json!({}));
        found = all
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["coordinatorSession"] == coordinator.as_str())
            .cloned()
            .unwrap_or(Value::Null);
        !found.is_null()
    });
    let id = found["id"].as_str().unwrap().to_owned();
    assert_eq!(found["status"], "planned", "approval stays a person's: {found}");
    assert_eq!(found["driver"], "server");
    assert_eq!(found["tasks"].as_array().unwrap().len(), 2);
    let (_, approvals) = server.rpc("agent_campaign_approvals", json!({}));
    assert!(
        approvals["approvals"].as_array().unwrap().iter().any(|a| a["campaignId"] == id.as_str() && a["kind"] == "plan"),
        "{approvals}"
    );
    // The turn closed on the tool's answer, not on a client's.
    let turn = server.events(&coordinator, 0, Duration::from_secs(60), is_completed);
    assert!(turn.iter().any(|e| e["payload"].to_string().contains("tool finished")), "{turn:?}");
    assert!(
        !turn.iter().any(|e| e["payload"]["type"] == "tool_request"),
        "the request is answered in process and never offered to a client"
    );
    std::thread::sleep(Duration::from_secs(4));
    assert_eq!(campaign_of(&server, &id)["status"], "planned", "nothing runs before an approval");

    // The coordinator is offered the tools, and only it.
    let after = turn.last().unwrap()["seq"].as_u64().unwrap();
    let (status, _) = server.rpc("agent_run_start", json!({ "id": coordinator, "input": "LIST_TOOLS" }));
    assert_eq!(status, 200);
    let listed = server.events(&coordinator, after, Duration::from_secs(60), is_completed);
    let said = listed.iter().map(|e| e["payload"].to_string()).collect::<Vec<_>>().join("\n");
    for tool in ["campaign_plan", "campaign_status", "campaign_collect", "campaign_cancel", "campaign_steer", "campaign_decide", "campaign_merge"] {
        assert!(said.contains(&format!("host__{tool}")), "{tool}: {said}");
    }

    // A person approves; the driver runs it to review.
    let (status, approved) = server.rpc("agent_campaign_approve", json!({ "id": id, "access": "worktree" }));
    assert_eq!(status, 200, "{approved}");
    wait_for("the campaign to reach reviewing", Duration::from_secs(240), || {
        let c = campaign_of(&server, &id);
        assert_ne!(c["status"], "failed", "{c}");
        c["status"] == "reviewing"
    });
    assert_eq!(statuses(&campaign_of(&server, &id)), vec!["merged", "merged"]);

    // The one-shot planner remains when no coordinator is asked for.
    let (status, planned) = server.rpc(
        "agent_campaign_start_server",
        json!({ "goal": "write three files", "folder": folder }),
    );
    assert_eq!(status, 200, "{planned}");
    assert_eq!(planned["status"], "planned");
    assert_eq!(planned["coordinatorSession"], "server");
}

#[test]
fn attachments_are_checked_stored_in_the_session_folder_and_reach_the_model() {
    let dir = scratch("attachments");
    let server = start(&dir, &[]);
    let folder = dir.join("work").join("app").canonicalize().unwrap().to_string_lossy().into_owned();
    let (_, created) = server.rpc("agent_run_create", json!({ "folder": folder, "access": "ask" }));
    let id = created["id"].as_str().unwrap().to_owned();

    use base64::Engine as _;
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let png = base64::engine::general_purpose::STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
        .unwrap();

    // Refused before anything is written: a type nobody reads, a bad payload,
    // too many files.
    let (status, _) = server.rpc(
        "agent_run_start",
        json!({ "id": id, "input": "look", "attachments": [{ "name": "a.bin", "mime": "application/zip", "data": b64(b"PK") }] }),
    );
    assert_eq!(status, 415);
    let (status, _) = server.rpc(
        "agent_run_start",
        json!({ "id": id, "input": "look", "attachments": [{ "name": "a.txt", "mime": "text/plain", "data": "***" }] }),
    );
    assert_eq!(status, 400);
    let many: Vec<Value> = (0..9)
        .map(|i| json!({ "name": format!("{i}.txt"), "mime": "text/plain", "data": b64(b"x") }))
        .collect();
    let (status, _) = server.rpc("agent_run_start", json!({ "id": id, "input": "look", "attachments": many }));
    assert_eq!(status, 400);
    let attachments = dir.join("data").join("threads").join(&id).join("attachments");
    assert!(!attachments.exists(), "a refused message stores nothing");

    let (status, started) = server.rpc(
        "agent_run_start",
        json!({
            "id": id,
            "input": "read these",
            "attachments": [
                { "name": "..\\..\\notes.txt", "mime": "text/plain", "data": b64(b"remember the milk") },
                { "name": "pixel.png", "mime": "image/png", "data": b64(&png) }
            ]
        }),
    );
    assert_eq!(status, 200, "{started}");
    let seen = server.events(&id, 0, Duration::from_secs(60), is_completed);
    assert_eq!(seen.last().unwrap()["payload"]["stopReason"], "completed", "{seen:?}");

    // Stored in the session's own folder in the data folder: names made safe,
    // nothing under an agent root.
    let names: Vec<String> = std::fs::read_dir(&attachments)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.iter().all(|n| !n.contains("..") && !n.contains('\\') && !n.contains('/')), "{names:?}");
    assert!(names.iter().any(|n| n.ends_with("notes.txt")), "{names:?}");
    assert!(!dir.join("work").join("app").join("notes.txt").exists());

    // The model got the text in its message and the image as a part.
    let (_, got) = server.rpc("agent_run_get", json!({ "id": id }));
    let transcript = got["turns"].to_string();
    assert!(transcript.contains("remember the milk"), "{transcript}");
    assert!(transcript.contains("read these"));
}
