//! The server's agent sessions, read-only: what a client that is signed in to
//! `flint serve` can list, open and replay while the runner itself (phase P1
//! of docs/MOBILE.md, "Server runner") is not built.
//!
//! Sessions are the threads of the server's data folder that an agent wrote
//! (the CLI/TUI loop and campaign tasks), read from
//! `<data>/threads/<id>/{thread.json,messages.jsonl}` and, for the event
//! replay, from the agent plugin's event log.
//!
//! Confinement: a session is visible only when the folder it worked in
//! resolves inside one of the operator's `--agent-root` folders. A session
//! that records no folder is not visible; the runner will stamp `folder` on
//! every session it starts.
//!
//! Not mapped to the transcript yet (see `NOT_MAPPED`): tool images,
//! reasoning, the display journal, subagent runs, goal state, plan snapshots,
//! compaction dividers and per-turn usage. A transcript row is `role` and
//! `content`, plus a `tool` row (`callId`, `name`, `args`, `result`, `isError`)
//! per tool call.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::agent::campaign;
use crate::core::threads::{
    branching, constants::THREADS_FILE, helpers::read_messages_from_file, utils,
};
use tauri_plugin_agent_tools::event_log;

use super::agent::Fail;

/// Replay events returned per request; the client asks again with `after=`.
pub const REPLAY_PAGE: usize = 2000;
/// Sessions listed at most.
const LIST_LIMIT: usize = 500;

/// What a transcript fetched here does not carry yet.
pub const NOT_MAPPED: &[&str] = &[
    "reasoning",
    "tool images",
    "subagent runs",
    "goal state",
    "plan snapshots",
    "compaction dividers",
    "per-turn usage",
];

fn fail(status: u16, message: impl Into<String>) -> Fail {
    Fail {
        status,
        body: Value::String(message.into()),
    }
}

/// A session's summary row, and the thread it came from.
struct Found {
    row: Value,
}

fn inside(roots: &[PathBuf], raw: &str) -> bool {
    if raw.is_empty() || raw.contains('\0') {
        return false;
    }
    match Path::new(raw).canonicalize() {
        Ok(path) => roots.iter().any(|root| path.starts_with(root)),
        Err(_) => false,
    }
}

/// The folder a thread worked in: what it names itself, else the checkout it
/// holds, else the repository it snapshots.
fn thread_folder(thread: &Value) -> Option<String> {
    let meta = thread.get("metadata")?;
    for key in ["folder", "project", "snapshot_repo"] {
        if let Some(path) = meta.get(key).and_then(Value::as_str).filter(|p| !p.is_empty()) {
            return Some(path.to_owned());
        }
    }
    meta.pointer("/worktree/path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
}

/// Session id -> (campaign id, campaign title, source root, running).
fn campaign_links(data_folder: &Path) -> HashMap<String, (String, String, String, bool)> {
    let mut links = HashMap::new();
    for c in campaign::list(data_folder) {
        let running = c.status == campaign::CampaignStatus::Running;
        links.insert(
            c.coordinator_session.clone(),
            (c.id.clone(), c.title.clone(), c.source_root.clone(), false),
        );
        for task in &c.tasks {
            if let Some(session) = &task.session_id {
                let active = running && task.status == campaign::TaskStatus::Running;
                links.insert(
                    session.clone(),
                    (c.id.clone(), c.title.clone(), c.source_root.clone(), active),
                );
            }
        }
    }
    links
}

fn summarize(
    id: &str,
    thread: &Value,
    links: &HashMap<String, (String, String, String, bool)>,
) -> (Value, Option<String>) {
    let link = links.get(id);
    let folder = thread_folder(thread).or_else(|| link.map(|l| l.2.clone()));
    let title = thread
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_owned());
    let row = json!({
        "id": id,
        "title": title,
        "folder": folder,
        "mode": thread.pointer("/metadata/mode").and_then(Value::as_str),
        "model": thread.pointer("/model/id").and_then(Value::as_str),
        "updated": thread.get("updated").and_then(Value::as_f64),
        // P0 starts nothing, so only a campaign task a desktop is running can
        // be live; everything else is at rest.
        "status": if link.is_some_and(|l| l.3) { "running" } else { "idle" },
        "campaign": link.map(|l| json!({ "id": l.0, "title": l.1 })),
    });
    (row, folder)
}

fn read_thread(data_folder: &Path, id: &str) -> Result<Value, Fail> {
    utils::validate_thread_id(id).map_err(|_| fail(400, "invalid session id"))?;
    let raw = std::fs::read_to_string(utils::get_thread_metadata_path(data_folder, id))
        .map_err(|_| fail(404, "that session does not exist on this server"))?;
    serde_json::from_str(&raw).map_err(|_| fail(404, "that session cannot be read"))
}

fn open(data_folder: &Path, roots: &[PathBuf], id: &str) -> Result<(Found, Value), Fail> {
    let thread = read_thread(data_folder, id)?;
    let links = campaign_links(data_folder);
    let (row, folder) = summarize(id, &thread, &links);
    match folder {
        Some(f) if inside(roots, &f) => Ok((Found { row }, thread)),
        _ => Err(fail(403, "that session is outside the folders this server allows")),
    }
}

/// Every visible session, newest first.
pub fn list(data_folder: &Path, roots: &[PathBuf]) -> Value {
    let dir = utils::get_data_dir(data_folder);
    let links = campaign_links(data_folder);
    let mut rows: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let Ok(id) = entry.file_name().into_string() else { continue };
            if utils::validate_thread_id(&id).is_err() {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(entry.path().join(THREADS_FILE)) else {
                continue;
            };
            let Ok(thread) = serde_json::from_str::<Value>(&raw) else { continue };
            let (row, folder) = summarize(&id, &thread, &links);
            // Only what an agent wrote: a plain chat names no folder.
            if folder.is_some_and(|f| inside(roots, &f)) {
                rows.push(row);
            }
        }
    }
    rows.sort_by(|a, b| {
        let key = |v: &Value| v["updated"].as_f64().unwrap_or(0.0);
        key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(LIST_LIMIT);
    json!({ "sessions": rows })
}

fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str).map_or(true, |t| t == "text"))
            .filter_map(|p| match p.get("text") {
                Some(Value::String(s)) => Some(s.as_str()),
                Some(obj) => obj.get("value").and_then(Value::as_str),
                None => None,
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Stored messages as the renderer's transcript rows.
pub fn turns(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    // call id -> index of its tool row
    let mut calls: HashMap<String, usize> = HashMap::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let content = message_text(message.get("content"));
        match role {
            "user" => out.push(json!({ "role": "user", "content": content })),
            "assistant" => {
                if !content.is_empty() || message.get("tool_calls").is_none() {
                    out.push(json!({ "role": "assistant", "content": content }));
                }
                for call in message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let call_id = call.get("id").and_then(Value::as_str).unwrap_or("");
                    let name = call.pointer("/function/name").and_then(Value::as_str).unwrap_or("");
                    let raw = call.pointer("/function/arguments").and_then(Value::as_str);
                    let args = raw
                        .and_then(|r| serde_json::from_str::<Value>(r).ok())
                        .unwrap_or(Value::Null);
                    if !call_id.is_empty() {
                        calls.insert(call_id.to_owned(), out.len());
                    }
                    out.push(json!({
                        "role": "tool",
                        "content": "",
                        "callId": call_id,
                        "name": name,
                        "args": args,
                        "status": "running",
                    }));
                }
            }
            "tool" => {
                let id = message.get("tool_call_id").and_then(Value::as_str).unwrap_or("");
                if let Some(&at) = calls.get(id) {
                    out[at]["result"] = Value::String(content);
                    out[at]["status"] = json!("done");
                    out[at]["toolState"] = json!("succeeded");
                }
            }
            _ => {}
        }
    }
    out
}

/// One session's transcript (the active branch of the thread).
pub fn get(data_folder: &Path, roots: &[PathBuf], id: &str) -> Result<Value, Fail> {
    let (found, thread) = open(data_folder, roots, id)?;
    let messages = read_messages_from_file(data_folder, id)
        .map_err(|_| fail(500, "that session's messages cannot be read"))?;
    let active = branching::active_path(&messages, branching::thread_active_root(&thread).as_deref());
    let mut row = found.row;
    row["turns"] = Value::Array(turns(&active));
    row["messageCount"] = json!(active.len());
    row["notMapped"] = json!(NOT_MAPPED);
    Ok(row)
}

/// The `after` a client resumes from: the larger of the query value and the
/// `Last-Event-ID` the browser sends on reconnect.
pub fn resume_point(query_after: Option<&str>, last_event_id: Option<&str>) -> u64 {
    let parse = |v: Option<&str>| v.and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
    parse(query_after).max(parse(last_event_id))
}

fn frame(seq: u64, event: &Value) -> String {
    format!("id: {seq}\ndata: {event}\n\n")
}

/// The session's events after `after`, as one finite server-sent-events body.
/// A stored event log is replayed when the session has one; otherwise the
/// transcript is replayed as `message` events numbered from 1 in stored order.
/// The body ends with an `end` event naming the last seq and whether more
/// remain, so a client reconnects with `after=<last>` until `more` is false.
pub fn replay(data_folder: &Path, roots: &[PathBuf], id: &str, after: u64) -> Result<String, Fail> {
    let (_, thread) = open(data_folder, roots, id)?;
    let logged = event_log::read_session(data_folder, id)
        .map_err(|e| fail(500, e.message()))?;
    let events: Vec<(u64, Value)> = if logged.is_empty() {
        let messages = read_messages_from_file(data_folder, id)
            .map_err(|_| fail(500, "that session's messages cannot be read"))?;
        let active =
            branching::active_path(&messages, branching::thread_active_root(&thread).as_deref());
        active
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let seq = i as u64 + 1;
                (
                    seq,
                    json!({
                        "seq": seq,
                        "source": "transcript",
                        "kind": "message",
                        "at": m.get("created_at"),
                        "payload": {
                            "role": m.get("role"),
                            "content": message_text(m.get("content")),
                            "toolCalls": m.get("tool_calls"),
                            "callId": m.get("tool_call_id"),
                        },
                    }),
                )
            })
            .collect()
    } else {
        logged
            .into_iter()
            .map(|e| {
                (
                    e.seq,
                    json!({
                        "seq": e.seq,
                        "source": "log",
                        "kind": e.kind,
                        "at": e.at,
                        "run": e.run,
                        "invocation": e.invocation,
                        "payload": e.payload,
                    }),
                )
            })
            .collect()
    };
    let total = events.iter().filter(|(seq, _)| *seq > after).count();
    let mut body = String::from(": replay\n\n");
    let mut last = after;
    for (seq, event) in events.iter().filter(|(seq, _)| *seq > after).take(REPLAY_PAGE) {
        body.push_str(&frame(*seq, event));
        last = *seq;
    }
    body.push_str(&format!(
        "event: end\ndata: {}\n\n",
        json!({ "last": last, "more": total > REPLAY_PAGE })
    ));
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let project = work.path().join("app");
        std::fs::create_dir_all(&project).unwrap();
        let root = work.path().canonicalize().unwrap();
        (data, work, root)
    }

    fn write_thread(data: &Path, id: &str, folder: Option<&Path>, messages: &[Value]) {
        let dir = utils::get_thread_dir(data, id);
        std::fs::create_dir_all(&dir).unwrap();
        let mut meta = json!({});
        if let Some(f) = folder {
            meta["folder"] = json!(f.to_string_lossy());
        }
        std::fs::write(
            dir.join("thread.json"),
            json!({ "id": id, "title": "T", "updated": 5.0, "model": { "id": "m" }, "metadata": meta })
                .to_string(),
        )
        .unwrap();
        let lines: Vec<String> = messages.iter().map(|m| m.to_string()).collect();
        std::fs::write(dir.join("messages.jsonl"), lines.join("\n") + "\n").unwrap();
    }

    fn msgs() -> Vec<Value> {
        vec![
            json!({ "role": "user", "content": [{ "type": "text", "text": { "value": "hi" } }] }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": { "value": "ok" } }],
                   "tool_calls": [{ "id": "c1", "function": { "name": "read", "arguments": "{\"path\":\"a\"}" } }] }),
            json!({ "role": "tool", "tool_call_id": "c1", "content": [{ "type": "text", "text": { "value": "data" } }] }),
        ]
    }

    #[test]
    fn list_shows_only_sessions_inside_a_root() {
        let (data, work, root) = fixture();
        let project = root.join("app");
        write_thread(data.path(), "in", Some(&project), &msgs());
        write_thread(data.path(), "out", Some(data.path()), &msgs());
        write_thread(data.path(), "chat", None, &msgs());
        let listed = list(data.path(), &[root]);
        let ids: Vec<&str> =
            listed["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["in"]);
        drop(work);
    }

    #[test]
    fn get_maps_tool_calls_and_refuses_outside_sessions() {
        let (data, _work, root) = fixture();
        write_thread(data.path(), "in", Some(&root.join("app")), &msgs());
        write_thread(data.path(), "out", Some(data.path()), &msgs());
        let got = get(data.path(), &[root.clone()], "in").unwrap();
        let turns = got["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0]["content"], "hi");
        assert_eq!(turns[2]["role"], "tool");
        assert_eq!(turns[2]["name"], "read");
        assert_eq!(turns[2]["result"], "data");
        assert_eq!(get(data.path(), &[root.clone()], "out").unwrap_err().status, 403);
        assert_eq!(get(data.path(), &[root.clone()], "nope").unwrap_err().status, 404);
        assert_eq!(get(data.path(), &[root], "../x").unwrap_err().status, 400);
    }

    #[test]
    fn replay_resumes_after_a_seq() {
        let (data, _work, root) = fixture();
        write_thread(data.path(), "in", Some(&root.join("app")), &msgs());
        let all = replay(data.path(), &[root.clone()], "in", 0).unwrap();
        assert_eq!(all.matches("\nid: ").count() + usize::from(all.starts_with("id: ")), 3);
        assert!(all.contains("\"last\":3"));
        let rest = replay(data.path(), &[root.clone()], "in", 2).unwrap();
        assert!(rest.contains("id: 3\n"));
        assert!(!rest.contains("id: 2\n"));
        let none = replay(data.path(), &[root.clone()], "in", 3).unwrap();
        assert!(!none.contains("id: "));
        assert!(none.contains("\"more\":false"));
        assert_eq!(resume_point(Some("2"), Some("5")), 5);
        assert_eq!(resume_point(None, Some("junk")), 0);
    }
}
