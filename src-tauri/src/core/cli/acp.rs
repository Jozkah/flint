//! `flint cli acp`: an Agent Client Protocol server on stdin/stdout, so an
//! editor (Zed and others that speak ACP) can launch Flint as its agent.
//!
//! Newline-delimited JSON-RPC 2.0. Stdout carries protocol records only; logs
//! go to stderr. Supported: `initialize`, `session/new`, `session/prompt`,
//! `session/cancel`, and the agent-to-client `session/request_permission`.
//! The `fs/*` and `terminal/*` client methods are not used: the agent's own
//! tools work on the project directly, under the same gate as every other
//! headless run.
//!
//! The file is split in two. The upper half is a pure mapping layer (JSON in,
//! JSON out) that the tests drive; the lower half is the process plumbing that
//! runs the shared turn steps of [`super::turn_host`], so ACP drives the same
//! loop as `flint cli agent rpc` rather than a copy of it.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use tokio::sync::mpsc;

use super::providers::ProviderOverrides;
use super::rpc::{await_mcp, input_lines, output_lines};
use super::turn_host::{begin_turn, settle_turn, spawn_turn, Persist, TurnMessage, TurnTask};
use super::{agent_dir_for, prepare_agent_session, AgentSession, SessionFlags};
use crate::core::agent::events::StreamEvent;

/// The ACP version this server speaks.
pub const ACP_PROTOCOL_VERSION: u32 = 1;

/// How long a permission request may wait for the editor before it is denied.
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(600);

const OUTPUT_CAPACITY: usize = 1024;

// ── pure mapping layer ──────────────────────────────────────────────────────

pub(crate) fn response(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

pub(crate) fn error(id: &Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","method":method,"params":params})
}

/// The `initialize` result: what this agent offers.
pub(crate) fn initialize_result() -> Value {
    json!({
        "protocolVersion": ACP_PROTOCOL_VERSION,
        "agentCapabilities": {
            "loadSession": false,
            "promptCapabilities": {"image": false, "audio": false, "embeddedContext": false},
        },
        "authMethods": [],
    })
}

/// The text of a `session/prompt`'s content blocks. `text` blocks are used
/// as written and `resource_link` blocks become an `@path` line; other block
/// kinds are described, not fatal, so a client that always attaches one still works.
pub(crate) fn prompt_text(prompt: &Value) -> Result<String, String> {
    let blocks = prompt.as_array().ok_or("prompt must be an array of content blocks")?;
    let mut parts: Vec<String> = Vec::with_capacity(blocks.len());
    for (index, block) in blocks.iter().enumerate() {
        match (block["type"].as_str(), block["text"].as_str()) {
            (Some("text"), Some(text)) => parts.push(text.to_owned()),
            (Some("text"), None) => return Err(format!("prompt[{index}]: text block has no text")),
            (Some("resource_link"), _) => {
                let uri = block["uri"].as_str().ok_or(format!("prompt[{index}]: resource_link has no uri"))?;
                parts.push(format!("@{}", uri.strip_prefix("file://").unwrap_or(uri)));
            }
            (Some(other), _) => parts.push(format!("[unsupported {other} content omitted]")),
            (None, _) => return Err(format!("prompt[{index}]: content block has no type")),
        }
    }
    let text = parts.join("\n\n");
    if text.trim().is_empty() {
        return Err("prompt has no text".to_owned());
    }
    Ok(text)
}

/// What one incoming line asks the server to do.
#[derive(Debug, PartialEq)]
pub(crate) enum Incoming {
    /// Answer immediately with this record.
    Reply(Value),
    /// Nothing to do (an unknown or ignored notification).
    Ignore,
    /// `session/new`: build a session for `cwd` under `session_id`.
    NewSession { id: Value, session_id: String, cwd: String },
    /// `session/prompt`: run one turn.
    Prompt { id: Value, session_id: String, text: String },
    /// `session/cancel` notification.
    Cancel { session_id: String },
    /// The editor's answer to a request this server sent.
    Answer { id: Value, message: Value },
}

/// A fresh session id. Uuid-based so ids never repeat across sessions.
pub(crate) fn new_session_id() -> String {
    format!("sess_{}", uuid::Uuid::new_v4().simple())
}

/// Classify one input line. Pure: no session state is touched.
pub(crate) fn route(line: &[u8]) -> Incoming {
    let message: Value = match serde_json::from_slice(line) {
        Ok(value) => value,
        Err(_) => return Incoming::Reply(error(&Value::Null, -32700, "Parse error")),
    };
    let id = message.get("id").cloned();
    if !message.is_object() || message["jsonrpc"] != "2.0" {
        return Incoming::Reply(error(&id.unwrap_or(Value::Null), -32600, "Invalid Request"));
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        // No method: a response to one of our requests.
        return match id {
            Some(id) if message.get("result").is_some() || message.get("error").is_some() => {
                Incoming::Answer { id, message }
            }
            other => Incoming::Reply(error(&other.unwrap_or(Value::Null), -32600, "Invalid Request")),
        };
    };
    let params = &message["params"];
    let Some(id) = id else {
        // Notifications get no reply, even when unknown.
        return match (method, params["sessionId"].as_str()) {
            ("session/cancel", Some(session_id)) => Incoming::Cancel { session_id: session_id.to_owned() },
            _ => Incoming::Ignore,
        };
    };
    match method {
        "initialize" => Incoming::Reply(response(&id, initialize_result())),
        "session/new" => match params["cwd"].as_str() {
            Some(cwd) if !cwd.trim().is_empty() => {
                Incoming::NewSession { id, session_id: new_session_id(), cwd: cwd.to_owned() }
            }
            _ => Incoming::Reply(error(&id, -32602, "session/new requires cwd")),
        },
        "session/prompt" => match (params["sessionId"].as_str(), prompt_text(&params["prompt"])) {
            (None, _) => Incoming::Reply(error(&id, -32602, "session/prompt requires sessionId")),
            (_, Err(message)) => Incoming::Reply(error(&id, -32602, &message)),
            (Some(session_id), Ok(text)) => Incoming::Prompt { id, session_id: session_id.to_owned(), text },
        },
        _ => Incoming::Reply(error(&id, -32601, "Method not found")),
    }
}

/// The ACP tool kind for one of Flint's tool names.
pub(crate) fn tool_kind(name: &str) -> &'static str {
    match name {
        "read" | "ls" | "list" => "read",
        "write" | "edit" | "multi_edit" | "apply_patch" => "edit",
        "delete" => "delete",
        "move" | "rename" => "move",
        "grep" | "glob" | "find" | "search" | "web_search" => "search",
        "bash" | "exec" | "shell" => "execute",
        "web_fetch" | "fetch" => "fetch",
        "think" => "think",
        _ => "other",
    }
}

/// A one-line title for a call: its name and its main argument when it has one.
fn tool_title(name: &str, args: &Value) -> String {
    let detail = ["command", "path", "file_path", "pattern", "url", "query"]
        .iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str));
    match detail {
        Some(detail) => {
            let detail: String = detail.chars().take(120).collect();
            format!("{name}: {detail}")
        }
        None => name.to_owned(),
    }
}

/// What the mapping remembers between events of one turn.
#[derive(Default)]
pub(crate) struct ToolTracker {
    /// Calls already announced with a `tool_call` update.
    announced: HashSet<String>,
    /// The latest call id per tool name, for attributing a permission prompt
    /// (which carries the tool name, not the call id).
    latest: HashMap<String, String>,
    /// Calls announced but not finished yet.
    open: HashSet<String>,
    /// The engine's stop reason from its `Done` event.
    pub done_stop_reason: Option<String>,
}

fn update(session_id: &str, update: Value) -> Value {
    notification("session/update", json!({"sessionId":session_id,"update":update}))
}

/// The `session/update` notifications for one engine event. Most events have
/// no ACP counterpart and map to nothing.
pub(crate) fn map_event(session_id: &str, event: &StreamEvent, tracker: &mut ToolTracker) -> Vec<Value> {
    match event {
        StreamEvent::Token { text } if !text.is_empty() => vec![update(
            session_id,
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
        )],
        StreamEvent::Reasoning { text } if !text.is_empty() => vec![update(
            session_id,
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":text}}),
        )],
        StreamEvent::ToolCallStarted { id, name } => {
            tracker.latest.insert(name.clone(), id.clone());
            if !tracker.announced.insert(id.clone()) {
                return Vec::new();
            }
            tracker.open.insert(id.clone());
            vec![update(
                session_id,
                json!({"sessionUpdate":"tool_call","toolCallId":id,"title":name,"kind":tool_kind(name),"status":"pending"}),
            )]
        }
        StreamEvent::ToolCall { id, name, args } => {
            tracker.latest.insert(name.clone(), id.clone());
            tracker.open.insert(id.clone());
            let title = tool_title(name, args);
            if tracker.announced.insert(id.clone()) {
                vec![update(
                    session_id,
                    json!({"sessionUpdate":"tool_call","toolCallId":id,"title":title,"kind":tool_kind(name),"status":"in_progress","rawInput":args}),
                )]
            } else {
                vec![update(
                    session_id,
                    json!({"sessionUpdate":"tool_call_update","toolCallId":id,"title":title,"status":"in_progress","rawInput":args}),
                )]
            }
        }
        StreamEvent::ToolResult { id, content, is_error, .. } => {
            tracker.open.remove(id);
            vec![update(
                session_id,
                json!({
                    "sessionUpdate":"tool_call_update","toolCallId":id,
                    "status": if *is_error { "failed" } else { "completed" },
                    "content":[{"type":"content","content":{"type":"text","text":content}}],
                }),
            )]
        }
        StreamEvent::Done { stop_reason, .. } => {
            tracker.done_stop_reason = Some(stop_reason.clone());
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// `failed` updates for every call still open when a turn ends without
/// finishing them (a cancel or an engine error).
pub(crate) fn close_open_calls(session_id: &str, tracker: &mut ToolTracker) -> Vec<Value> {
    let mut open: Vec<String> = tracker.open.drain().collect();
    open.sort();
    open.into_iter()
        .map(|id| update(session_id, json!({"sessionUpdate":"tool_call_update","toolCallId":id,"status":"failed"})))
        .collect()
}

/// The ACP stop reason for a finished turn.
pub(crate) fn stop_reason(engine: Option<&str>, cancelled: bool) -> &'static str {
    if cancelled {
        return "cancelled";
    }
    match engine {
        Some("length" | "max_tokens") => "max_tokens",
        Some("content_filter" | "refusal") => "refusal",
        _ => "end_turn",
    }
}

/// The `session/request_permission` request for a gate prompt, sent with this
/// server's request id `rpc_id`. Only one-shot options are offered: an
/// "always" grant would outlive what the editor showed.
pub(crate) fn permission_request(
    rpc_id: u64,
    session_id: &str,
    event: &StreamEvent,
    tracker: &ToolTracker,
) -> Option<Value> {
    let StreamEvent::PermissionRequest { request_id, tool_name, path, command, diff, reason, call_id, prompt_kind, .. } = event
    else {
        return None;
    };
    // The call the prompt is about; the latest call of that tool only for an
    // event that does not say (parallel calls of one tool would be confused).
    let tool_call_id = call_id
        .clone()
        .or_else(|| tracker.latest.get(tool_name).cloned())
        .unwrap_or_else(|| request_id.clone());
    let mut raw_input = serde_json::Map::new();
    if let Some(path) = path {
        raw_input.insert("path".into(), json!(path));
    }
    if let Some(command) = command {
        raw_input.insert("command".into(), json!(command));
    }
    if let Some(diff) = diff {
        raw_input.insert("diff".into(), json!(diff));
    }
    if let Some(reason) = reason {
        raw_input.insert("reason".into(), json!(reason));
    }
    let title = tool_title(tool_name, &Value::Object(raw_input.clone()));
    // A write the credential scan flagged: the one-shot answer is "write it
    // anyway", and says so rather than a bare "Allow once".
    let allow_label = if prompt_kind == "secret" { "Write anyway" } else { "Allow once" };
    Some(json!({
        "jsonrpc":"2.0","id":rpc_id,"method":"session/request_permission",
        "params":{
            "sessionId":session_id,
            "toolCall":{"toolCallId":tool_call_id,"title":title,"kind":tool_kind(tool_name),"status":"pending","rawInput":raw_input},
            "options":[
                {"optionId":"allow_once","name":allow_label,"kind":"allow_once"},
                {"optionId":"reject_once","name":"Reject","kind":"reject_once"},
            ],
        }
    }))
}

/// The gate decision for the editor's answer to a permission request. Only an
/// explicit `allow_once` selection allows; anything else (reject, cancelled,
/// an error, an unknown option) denies.
pub(crate) fn decision_from_answer(message: &Value) -> PermissionDecision {
    let outcome = &message["result"]["outcome"];
    if outcome["outcome"] == "selected" && outcome["optionId"] == "allow_once" {
        PermissionDecision::AllowOnce
    } else {
        PermissionDecision::Deny
    }
}

// ── process plumbing ────────────────────────────────────────────────────────

struct Session {
    agent: AgentSession,
    history: Vec<Value>,
}

struct ActiveTurn {
    session_id: String,
    rpc_id: Value,
    task: TurnTask,
    updated_history: Option<Vec<Value>>,
    tracker: ToolTracker,
}

/// A permission request waiting on the editor: the gate's request id and when
/// it is denied unanswered.
struct PendingPermission {
    request_id: String,
    deadline: Instant,
}

async fn send(out: &mpsc::Sender<Value>, record: Value) -> Result<(), String> {
    out.send(record).await.map_err(|_| "ACP client closed stdout".to_owned())
}

/// Answer one gate prompt, if it is still waiting.
async fn resolve(agent: &AgentSession, request_id: &str, decision: PermissionDecision) {
    if let Some(sender) = agent.permission_requests.lock().await.remove(request_id) {
        let _ = sender.send(decision);
    }
}

/// Deny every prompt the turn still holds.
async fn deny_all(agent: &AgentSession, pending: &mut HashMap<u64, PendingPermission>) {
    for (_, waiting) in pending.drain() {
        resolve(agent, &waiting.request_id, PermissionDecision::Deny).await;
    }
    // Dropping the rest resolves them to Deny on the loop's side.
    agent.permission_requests.lock().await.clear();
}

/// Fold a finished turn into its session and answer its `session/prompt`.
async fn finish(
    sessions: &mut HashMap<String, Session>,
    mut turn: ActiveTurn,
    result: Result<Value, String>,
    cancelled: bool,
    out: &mpsc::Sender<Value>,
) -> Result<(), String> {
    turn.task.steerer.abort();
    let Some(session) = sessions.get_mut(&turn.session_id) else {
        return send(out, error(&turn.rpc_id, -32603, "session missing")).await;
    };
    let project = session.agent.args.project_root.clone();
    let base = project.as_deref().map(agent_dir_for);
    let settled = settle_turn(
        &mut session.history,
        turn.updated_history.take(),
        &result,
        cancelled,
        base.as_deref().map(|base| Persist {
            base,
            session_id: &turn.session_id,
            model: &session.agent.model,
            metadata: None,
        }),
    );
    for record in close_open_calls(&turn.session_id, &mut turn.tracker) {
        send(out, record).await?;
    }
    let reply = match (cancelled, settled.error) {
        (false, Some(message)) => error(&turn.rpc_id, -32603, &message),
        _ => response(
            &turn.rpc_id,
            json!({"stopReason": stop_reason(turn.tracker.done_stop_reason.as_deref(), cancelled)}),
        ),
    };
    send(out, reply).await
}

async fn new_session(cwd: &str, session_id: &str) -> Result<Session, String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Err("cwd is not a directory".to_owned());
    }
    let mut agent = prepare_agent_session(
        cwd,
        None,
        ProviderOverrides::default(),
        SessionFlags { require_model: true, ..Default::default() },
        None,
    )?;
    await_mcp(&mut agent).await;
    agent.args.session_id = Some(session_id.to_owned());
    Ok(Session { agent, history: Vec::new() })
}

/// Serve ACP until stdin closes.
pub async fn serve() -> Result<(), String> {
    let input = input_lines();
    let (out, writer_rx) = mpsc::channel::<Value>(OUTPUT_CAPACITY);
    let writer = output_lines(writer_rx);
    serve_loop(input, out, |cwd, session_id| async move { new_session(&cwd, &session_id).await }).await?;
    writer.join().map_err(|_| "ACP output writer panicked".to_owned())?;
    Ok(())
}

/// The ACP message loop. `init` builds a session; it runs alongside the loop (it can take up to
/// the MCP wait), so cancels and permission answers for a running turn are still handled meanwhile.
async fn serve_loop<F, Fut>(mut input: mpsc::Receiver<(Vec<u8>, bool)>, out: mpsc::Sender<Value>, init: F) -> Result<(), String>
where
    F: Fn(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<Session, String>>,
{
    use futures_util::StreamExt;
    let mut inits = futures_util::stream::FuturesUnordered::new();
    let mut sessions = HashMap::<String, Session>::new();
    let mut active: Option<ActiveTurn> = None;
    let mut pending = HashMap::<u64, PendingPermission>::new();
    let mut next_request_id: u64 = 1;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            line = input.recv() => {
                let Some((line, too_long)) = line else { break };
                if too_long {
                    send(&out, error(&Value::Null, -32600, "Input line too long")).await?;
                    continue;
                }
                match route(&line) {
                    Incoming::Reply(record) => send(&out, record).await?,
                    Incoming::Ignore => {}
                    Incoming::NewSession { id, session_id, cwd } => {
                        let pending_init = init(cwd, session_id.clone());
                        inits.push(async move { (id, session_id, pending_init.await) });
                    }
                    Incoming::Prompt { id, session_id, text } => {
                        let reply = if active.is_some() {
                            Some(error(&id, -32001, "a prompt is already running"))
                        } else if let Some(session) = sessions.get_mut(&session_id) {
                            let body = begin_turn(&session.agent, &mut session.history, Value::String(text), true);
                            let task = spawn_turn(session.agent.args.clone(), body);
                            active = Some(ActiveTurn { session_id, rpc_id: id, task, updated_history: None, tracker: ToolTracker::default() });
                            None
                        } else {
                            Some(error(&id, -32602, "unknown sessionId"))
                        };
                        if let Some(reply) = reply { send(&out, reply).await?; }
                    }
                    Incoming::Cancel { session_id } => {
                        if active.as_ref().is_some_and(|turn| turn.session_id == session_id) {
                            let turn = active.take().expect("checked");
                            turn.task.runner.abort();
                            if let Some(session) = sessions.get(&session_id) {
                                deny_all(&session.agent, &mut pending).await;
                            }
                            finish(&mut sessions, turn, Err("cancelled".to_owned()), true, &out).await?;
                        }
                    }
                    Incoming::Answer { id, message } => {
                        let waiting = id.as_u64().and_then(|n| pending.remove(&n));
                        let session = active.as_ref().and_then(|turn| sessions.get(&turn.session_id));
                        if let (Some(waiting), Some(session)) = (waiting, session) {
                            resolve(&session.agent, &waiting.request_id, decision_from_answer(&message)).await;
                        }
                    }
                }
            }
            message = async { active.as_mut().expect("active").task.events.recv().await }, if active.is_some() => {
                let Some(message) = message else {
                    let turn = active.take().expect("active");
                    finish(&mut sessions, turn, Err("the run ended without an outcome".to_owned()), false, &out).await?;
                    continue;
                };
                match message {
                    TurnMessage::Event(event) => {
                        let event = *event;
                        let turn = active.as_mut().expect("active");
                        let prompt = match &event {
                            StreamEvent::PermissionRequest { .. } => Some(event.clone()),
                            StreamEvent::Subagent { event: inner, .. } if matches!(**inner, StreamEvent::PermissionRequest { .. }) => Some((**inner).clone()),
                            _ => None,
                        };
                        if let Some(prompt) = prompt {
                            let rpc_id = next_request_id;
                            next_request_id += 1;
                            if let (Some(request), StreamEvent::PermissionRequest { request_id, .. }) =
                                (permission_request(rpc_id, &turn.session_id, &prompt, &turn.tracker), &prompt)
                            {
                                pending.insert(rpc_id, PendingPermission { request_id: request_id.clone(), deadline: Instant::now() + PERMISSION_TIMEOUT });
                                send(&out, request).await?;
                            }
                            continue;
                        }
                        if let StreamEvent::MessagesUpdated { messages } = &event {
                            turn.updated_history = Some(messages.clone());
                        }
                        for record in map_event(&turn.session_id, &event, &mut turn.tracker) {
                            send(&out, record).await?;
                        }
                    }
                    TurnMessage::Finished(result) => {
                        let turn = active.take().expect("active");
                        pending.clear();
                        finish(&mut sessions, turn, result, false, &out).await?;
                    }
                }
            }
            Some((id, session_id, result)) = inits.next(), if !inits.is_empty() => {
                let reply = match result {
                    Ok(session) => {
                        sessions.insert(session_id.clone(), session);
                        response(&id, json!({"sessionId":session_id}))
                    }
                    Err(message) => error(&id, -32602, &message),
                };
                send(&out, reply).await?;
            }
            _ = tick.tick(), if !pending.is_empty() => {
                let now = Instant::now();
                let expired: Vec<u64> = pending.iter().filter(|(_, w)| w.deadline <= now).map(|(id, _)| *id).collect();
                for id in expired {
                    let waiting = pending.remove(&id).expect("listed");
                    log::warn!("ACP: permission request {id} was not answered in time; denied");
                    if let Some(session) = active.as_ref().and_then(|turn| sessions.get(&turn.session_id)) {
                        resolve(&session.agent, &waiting.request_id, PermissionDecision::Deny).await;
                    }
                }
            }
        }
    }
    // The editor is gone: deny what is waiting and stop the turn.
    if let Some(turn) = active.take() {
        if let Some(session) = sessions.get(&turn.session_id) {
            deny_all(&session.agent, &mut pending).await;
        }
        turn.task.runner.abort();
        let _ = finish(&mut sessions, turn, Err("client gone".to_owned()), true, &out).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(line: &str) -> Value {
        match route(line.as_bytes()) {
            Incoming::Reply(record) => record,
            other => panic!("expected a reply, got {other:?}"),
        }
    }

    #[test]
    fn initialize_reports_version_and_capabilities() {
        let record = reply(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#);
        assert_eq!(record["id"], 1);
        let result = &record["result"];
        assert_eq!(result["protocolVersion"], 1);
        assert_eq!(result["agentCapabilities"]["loadSession"], false);
        assert_eq!(
            result["agentCapabilities"]["promptCapabilities"],
            json!({"image":false,"audio":false,"embeddedContext":false})
        );
        assert_eq!(result["authMethods"], json!([]));
    }

    #[tokio::test]
    async fn the_loop_keeps_answering_while_a_session_is_being_created() {
        let (in_tx, in_rx) = mpsc::channel(8);
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = started.clone();
        let task = tokio::spawn(serve_loop(in_rx, out_tx, move |_, _| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            std::future::pending::<Result<Session, String>>()
        }));
        let line = |s: &str| (s.as_bytes().to_vec(), false);
        in_tx.send(line(r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":".","mcpServers":[]}}"#)).await.unwrap();
        in_tx.send(line(r#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}"#)).await.unwrap();
        in_tx.send(line(r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":1}}"#)).await.unwrap();
        let got = tokio::time::timeout(Duration::from_secs(5), out_rx.recv()).await.expect("loop blocked on session/new").unwrap();
        assert_eq!(got["id"], 2);
        assert!(started.load(std::sync::atomic::Ordering::SeqCst));
        drop(in_tx);
        tokio::time::timeout(Duration::from_secs(5), task).await.expect("loop did not stop").unwrap().unwrap();
    }

    #[test]
    fn an_unknown_method_is_method_not_found() {
        let record = reply(r#"{"jsonrpc":"2.0","id":"x","method":"fs/read_text_file","params":{}}"#);
        assert_eq!(record["id"], "x");
        assert_eq!(record["error"]["code"], -32601);
        // An unknown notification gets no reply at all.
        assert_eq!(route(br#"{"jsonrpc":"2.0","method":"nope"}"#), Incoming::Ignore);
    }

    #[test]
    fn malformed_json_is_a_parse_error_with_null_id() {
        let record = reply("{not json");
        assert_eq!(record["error"]["code"], -32700);
        assert!(record["id"].is_null());
        assert_eq!(reply(r#"{"id":3,"method":"initialize"}"#)["error"]["code"], -32600);
    }

    #[test]
    fn session_new_mints_distinct_ids() {
        let line = br#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp/p","mcpServers":[]}}"#;
        let ids: Vec<String> = (0..2)
            .map(|_| match route(line) {
                Incoming::NewSession { id, session_id, cwd } => {
                    assert_eq!(id, 2);
                    assert_eq!(cwd, "/tmp/p");
                    session_id
                }
                other => panic!("{other:?}"),
            })
            .collect();
        assert_ne!(ids[0], ids[1]);
        assert_eq!(reply(r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}"#)["error"]["code"], -32602);
    }

    #[test]
    fn prompt_accepts_text_links_and_describes_other_blocks() {
        let ok = route(br#"{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}"#);
        assert_eq!(ok, Incoming::Prompt { id: json!(4), session_id: "s".into(), text: "a\n\nb".into() });
        let link = route(br#"{"jsonrpc":"2.0","id":5,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"read"},{"type":"resource_link","uri":"file:///x/y.rs","name":"y"},{"type":"audio","data":"AA=="}]}}"#);
        assert_eq!(
            link,
            Incoming::Prompt { id: json!(5), session_id: "s".into(), text: "read\n\n@/x/y.rs\n\n[unsupported audio content omitted]".into() }
        );
        let record = reply(r#"{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"resource_link","name":"x"}]}}"#);
        assert_eq!(record["error"]["code"], -32602);
        assert_eq!(reply(r#"{"jsonrpc":"2.0","id":6,"method":"session/prompt","params":{"sessionId":"s","prompt":"hi"}}"#)["error"]["code"], -32602);
    }

    #[test]
    fn cancel_is_a_notification_and_reports_cancelled() {
        assert_eq!(
            route(br#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}"#),
            Incoming::Cancel { session_id: "s".into() }
        );
        assert_eq!(stop_reason(Some("stop"), true), "cancelled");
        assert_eq!(stop_reason(Some("stop"), false), "end_turn");
        assert_eq!(stop_reason(Some("length"), false), "max_tokens");
        assert_eq!(stop_reason(Some("content_filter"), false), "refusal");
        assert_eq!(stop_reason(None, false), "end_turn");
    }

    #[test]
    fn a_token_is_an_agent_message_chunk() {
        let mut tracker = ToolTracker::default();
        let records = map_event("s", &StreamEvent::Token { text: "hi".into() }, &mut tracker);
        assert_eq!(
            records,
            vec![json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}})]
        );
        assert!(map_event("s", &StreamEvent::Step { index: 1, max: 0 }, &mut tracker).is_empty());
    }

    #[test]
    fn tool_activity_maps_to_tool_call_and_updates() {
        let mut tracker = ToolTracker::default();
        let started = map_event("s", &StreamEvent::ToolCallStarted { id: "c1".into(), name: "bash".into() }, &mut tracker);
        let update = &started[0]["params"]["update"];
        assert_eq!(update["sessionUpdate"], "tool_call");
        assert_eq!(update["toolCallId"], "c1");
        assert_eq!(update["status"], "pending");
        assert_eq!(update["kind"], "execute");

        let call = map_event("s", &StreamEvent::ToolCall { id: "c1".into(), name: "bash".into(), args: json!({"command":"ls"}) }, &mut tracker);
        let update = &call[0]["params"]["update"];
        assert_eq!(update["sessionUpdate"], "tool_call_update");
        assert_eq!(update["status"], "in_progress");
        assert_eq!(update["title"], "bash: ls");
        assert_eq!(update["rawInput"], json!({"command":"ls"}));

        let done = map_event("s", &StreamEvent::ToolResult { id: "c1".into(), content: "a.txt".into(), is_error: false, diff: None }, &mut tracker);
        let update = &done[0]["params"]["update"];
        assert_eq!(update["status"], "completed");
        assert_eq!(update["content"], json!([{"type":"content","content":{"type":"text","text":"a.txt"}}]));

        // A call that was never announced by ToolCallStarted is announced by ToolCall.
        let fresh = map_event("s", &StreamEvent::ToolCall { id: "c2".into(), name: "read".into(), args: json!({"path":"x"}) }, &mut tracker);
        assert_eq!(fresh[0]["params"]["update"]["sessionUpdate"], "tool_call");
        assert_eq!(fresh[0]["params"]["update"]["status"], "in_progress");
        assert_eq!(fresh[0]["params"]["update"]["kind"], "read");
        let failed = map_event("s", &StreamEvent::ToolResult { id: "c2".into(), content: "ERROR: nope".into(), is_error: true, diff: None }, &mut tracker);
        assert_eq!(failed[0]["params"]["update"]["status"], "failed");
        assert!(close_open_calls("s", &mut tracker).is_empty());
    }

    #[test]
    fn calls_left_open_are_failed_when_the_turn_ends() {
        let mut tracker = ToolTracker::default();
        map_event("s", &StreamEvent::ToolCallStarted { id: "c9".into(), name: "write".into() }, &mut tracker);
        let closed = close_open_calls("s", &mut tracker);
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0]["params"]["update"], json!({"sessionUpdate":"tool_call_update","toolCallId":"c9","status":"failed"}));
    }

    #[test]
    fn done_records_the_engine_stop_reason() {
        let mut tracker = ToolTracker::default();
        assert!(map_event("s", &StreamEvent::Done { stop_reason: "length".into(), usage: None }, &mut tracker).is_empty());
        assert_eq!(stop_reason(tracker.done_stop_reason.as_deref(), false), "max_tokens");
    }

    fn prompt_event() -> StreamEvent {
        StreamEvent::PermissionRequest {
            request_id: "perm-1".into(),
            tool_name: "bash".into(),
            capability: "exec".into(),
            path: None,
            command: Some("rm -rf build".into()),
            diff: None,
            patch: None,
            prompt_kind: "exec".into(),
            offers_always: true,
            reason: None,
            args_digest: None,
            call_id: None,
        }
    }

    #[test]
    fn a_prompt_for_one_of_two_parallel_calls_names_that_call() {
        let mut tracker = ToolTracker::default();
        for id in ["c1", "c2"] {
            map_event("s", &StreamEvent::ToolCall { id: id.into(), name: "bash".into(), args: json!({"command":"ls"}) }, &mut tracker);
        }
        let mut event = prompt_event();
        if let StreamEvent::PermissionRequest { call_id, .. } = &mut event {
            *call_id = Some("c1".into());
        }
        let request = permission_request(7, "s", &event, &tracker).unwrap();
        assert_eq!(request["params"]["toolCall"]["toolCallId"], "c1");
    }

    #[test]
    fn a_gate_prompt_becomes_request_permission_with_one_shot_options() {
        let mut tracker = ToolTracker::default();
        map_event("s", &StreamEvent::ToolCall { id: "c1".into(), name: "bash".into(), args: json!({"command":"rm -rf build"}) }, &mut tracker);
        let request = permission_request(7, "s", &prompt_event(), &tracker).unwrap();
        assert_eq!(request["id"], 7);
        assert_eq!(request["method"], "session/request_permission");
        let params = &request["params"];
        assert_eq!(params["sessionId"], "s");
        assert_eq!(params["toolCall"]["toolCallId"], "c1");
        assert_eq!(params["toolCall"]["rawInput"]["command"], "rm -rf build");
        let kinds: Vec<&str> = params["options"].as_array().unwrap().iter().map(|o| o["kind"].as_str().unwrap()).collect();
        // Never an "always" option, even when the gate would offer one.
        assert_eq!(kinds, ["allow_once", "reject_once"]);
        // Not a prompt: nothing to send.
        assert!(permission_request(8, "s", &StreamEvent::Token { text: "x".into() }, &tracker).is_none());
        // No known call for the tool: the gate's request id stands in.
        let lone = permission_request(9, "s", &prompt_event(), &ToolTracker::default()).unwrap();
        assert_eq!(lone["params"]["toolCall"]["toolCallId"], "perm-1");
    }

    #[test]
    fn only_an_allow_once_selection_allows() {
        let selected = |option: &str| json!({"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"selected","optionId":option}}});
        assert_eq!(decision_from_answer(&selected("allow_once")), PermissionDecision::AllowOnce);
        assert_eq!(decision_from_answer(&selected("reject_once")), PermissionDecision::Deny);
        assert_eq!(decision_from_answer(&selected("allow_always")), PermissionDecision::Deny);
        assert_eq!(decision_from_answer(&selected("other")), PermissionDecision::Deny);
        let cancelled = json!({"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"cancelled"}}});
        assert_eq!(decision_from_answer(&cancelled), PermissionDecision::Deny);
        let failed = json!({"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"x"}});
        assert_eq!(decision_from_answer(&failed), PermissionDecision::Deny);
    }

    #[test]
    fn an_editor_answer_is_routed_as_an_answer() {
        let line = br#"{"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"cancelled"}}}"#;
        assert!(matches!(route(line), Incoming::Answer { id, .. } if id == 7));
    }
}
