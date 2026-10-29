//! Session-scoped JSON-RPC over LF-delimited stdio. Stdout contains only protocol records.
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc::{self, OwnedPermit};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::providers::ProviderOverrides;
use super::rpc_schema::{
    InitializeParams, PermissionOwner, PermissionResponseParams, SessionIdParams,
    SessionModelSetParams, SessionStartParams, SessionToolsSetParams, ToolRespondParams,
    ToolResultContent, TurnStartParams, TurnSteerParams,
};
use super::stream_input::{parse_input_line, MAX_LINE_BYTES};
use super::turn_host::{
    begin_turn, neutralize_user_content, parse_decision, release_requests, settle_turn, spawn_turn, Persist, TurnMessage,
};
use super::turn_host::TurnTask;
use super::{agent_dir_for, prepare_agent_session, AgentSession, OrchestrationArgs, SessionFlags};
use crate::core::agent::events::{StreamEvent, PROTOCOL_VERSION};
use crate::core::agent::host_tools::{HostToolDecl, HostToolResult, HostToolSet};

const OUTPUT_CAPACITY: usize = 1025; // 1024 ordinary records and one reserved terminal outcome.
const INPUT_CAPACITY: usize = 64;

struct Session {
    agent: AgentSession,
    history: Vec<Value>,
    id: String,
    turns: u32,
    ephemeral: bool,
    /// `false` restricts every turn to the host tools, through the same
    /// per-request `allowed_tools` allowlist an API caller uses.
    builtins: bool,
    /// `turn/steer` messages that arrived too late for the turn they were
    /// sent to (it ended before reading them). They open the next turn, in
    /// order, ahead of its own input, so a steer is never silently dropped.
    carried_steer: Vec<Value>,
}

struct ActiveTurn {
    session_id: String,
    turn_id: String,
    events: mpsc::Receiver<TurnMessage>,
    runner: JoinHandle<()>,
    steerer: JoinHandle<()>,
    pending: Arc<Mutex<Vec<Value>>>,
    updated_history: Option<Vec<Value>>,
    /// The slot the terminal record is written through, held for the whole
    /// turn. Reserving it up front is what makes "the outcome always arrives"
    /// a property of the channel rather than a convention every other writer
    /// has to keep: `capacity()` counts it as taken, so no notification, reply
    /// or event can be queued in its place.
    terminal: OwnedPermit<Value>,
}

fn response(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn error(id: &Value, code: i32, message: &str) -> Value {
    let data = if code == -32001 { json!({"retryable":true}) } else { Value::Null };
    error_data(id, code, message, data)
}

fn error_data(id: &Value, code: i32, message: &str, data: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message,"data":data}})
}

/// A verb that would change what the running turn reads (its tools, model or
/// history) is refused rather than applied mid-turn: the turn has already
/// built its request from the old state, so the change would take effect at
/// an arbitrary point in it.
fn turn_active(id: &Value) -> Value {
    error_data(
        id,
        -32001,
        "this session has an active turn; retry after turn/completed",
        json!({"retryable":true,"kind":"turn_active"}),
    )
}

fn invalid_tools(id: &Value, message: &str) -> Value {
    error_data(id, -32602, message, json!({"kind":"invalid_tools"}))
}

const UNKNOWN_SESSION: &str = "unknown sessionId";

/// Parse and declare a host tool set. Entries arrive as raw values so a bad
/// one is reported with its index and reason under `invalid_tools`, not as a
/// generic params error.
fn declare_tools(entries: Vec<Value>) -> Result<HostToolSet, String> {
    let decls = entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| {
            serde_json::from_value::<HostToolDecl>(entry).map_err(|e| format!("tools[{index}]: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    HostToolSet::declare(decls).map_err(|e| e.to_string())
}

/// What the session's next turn advertises, and the host schemas among it.
/// Filtered to the advertised set the way the stream-json `init` record is:
/// a host tool withheld by a deny list or Plan mode is not echoed, so the
/// host can see the suppression instead of waiting for a call.
async fn tools_view(session: &Session) -> Value {
    let args = &session.agent.args;
    let advertised = crate::core::agent::r#loop::context_advertised_tools(
        &args.mcp_servers,
        &args.mcp_settings,
        &args.permissions,
        args.project_root.as_deref(),
        args.run_mode,
        args.subagents_enabled,
        args.max_parallel_subagents,
        args.ask_requests.is_some(),
        args.todo_registry.is_some(),
        &args.host_tools,
    )
    .await;
    let mut tools: Vec<String> = advertised
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
        .collect();
    if !session.builtins {
        tools.retain(|name| args.host_tools.is_host_tool(name));
    }
    let specs: Vec<Value> = args
        .host_tools
        .schemas()
        .into_iter()
        .filter(|spec| {
            spec["function"]["name"]
                .as_str()
                .is_some_and(|name| tools.iter().any(|t| t == name))
        })
        .collect();
    json!({"tools":tools,"toolSpecs":specs})
}

/// Validate a content-part tool result with the same checks the stream-json
/// `tool_result` uses, returning its text summary.
fn check_result_parts(parts: &[Value]) -> Result<String, String> {
    super::stream_input::check_content_parts(parts, "tool_result")?;
    Ok(super::stream_input::summarize_parts(parts))
}

fn host_result(params: ToolRespondParams) -> Result<(String, HostToolResult), String> {
    let ToolRespondParams { request_id, content, is_error, details } = params;
    let (content, parts) = match content {
        ToolResultContent::Text(text) => (text, None),
        ToolResultContent::Parts(parts) => (check_result_parts(&parts)?, Some(parts)),
    };
    Ok((
        request_id,
        HostToolResult { content, parts, details: details.map(Value::Object), is_error },
    ))
}

/// Release every host request the turn still holds and tell the client which
/// ones it must no longer answer, before the turn's terminal record.
///
/// `client_gone` (stdin closed) is best effort: the client may have stopped
/// reading too, and waiting on it would keep the process alive forever. An
/// interrupt comes from a client that is reading, so its records are owed.
async fn release_host_requests(
    session: Option<&Session>,
    turn: &ActiveTurn,
    reason: &str,
    out: &mpsc::Sender<Value>,
) -> Result<(), String> {
    let Some(session) = session else { return Ok(()) };
    for event in release_requests(&session.agent.args, reason).await {
        let wire = serde_json::to_value(&event).map_err(|e| e.to_string())?;
        let params = json!({"sessionId":turn.session_id,"turnId":turn.turn_id,"event":wire});
        if reason == "client_gone" {
            let _ = notify(out, "item/tool_request_cancelled", params);
        } else {
            send_reply(out, json!({"jsonrpc":"2.0","method":"item/tool_request_cancelled","params":params})).await?;
        }
    }
    Ok(())
}

fn send(out: &mpsc::Sender<Value>, record: Value) -> Result<(), String> {
    out.try_send(record)
        .map_err(|_| "RPC output queue is full or closed".to_owned())
}

fn notify(out: &mpsc::Sender<Value>, method: &str, params: Value) -> Result<(), String> {
    send(
        out,
        json!({"jsonrpc":"2.0","method":method,"params":params}),
    )
}

/// A record a client is owed an answer with: it waits for room instead of
/// taking the slot the turn's terminal record reserved, and instead of turning
/// a client that stopped reading into a process that died holding the answer.
async fn send_reply(out: &mpsc::Sender<Value>, record: Value) -> Result<(), String> {
    out.send(record)
        .await
        .map_err(|_| "RPC client closed stdout".to_owned())
}

fn read_line(reader: &mut impl BufRead) -> std::io::Result<Option<(Vec<u8>, bool)>> {
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some((line, too_long)));
        }
        let n = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if !too_long {
            let available_bytes = MAX_LINE_BYTES.saturating_sub(line.len());
            line.extend_from_slice(&available[..n.min(available_bytes)]);
            too_long = n > available_bytes;
        }
        let done = available[n - 1] == b'\n';
        reader.consume(n);
        if done {
            return Ok(Some((line, too_long)));
        }
    }
}

pub(super) fn input_lines() -> mpsc::Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = mpsc::channel(INPUT_CAPACITY);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        while let Ok(Some(line)) = read_line(&mut stdin) {
            if tx.blocking_send(line).is_err() {
                break;
            }
        }
    });
    rx
}

pub(super) fn output_lines(mut rx: mpsc::Receiver<Value>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut writer = stdout.lock();
        while let Some(value) = rx.blocking_recv() {
            if serde_json::to_writer(&mut writer, &value).is_err()
                || writer.write_all(b"\n").is_err()
                || writer.flush().is_err()
            {
                break;
            }
        }
    })
}

fn start_turn(
    session: &mut Session,
    input: Value,
    out: &Arc<mpsc::Sender<Value>>,
    hooks: &Hooks,
) -> Result<ActiveTurn, String> {
    // Before the turn is accepted, not after: a queue with no room for the
    // terminal record is a queue this turn cannot report on, and accepting it
    // anyway is how a client that stopped reading loses the one record that
    // says the turn ended.
    let terminal = mpsc::Sender::clone(out)
        .try_reserve_owned()
        .map_err(|_| "RPC output queue is full; retry after draining notifications".to_owned())?;
    session.history.append(&mut session.carried_steer);
    let body = begin_turn(&session.agent, &mut session.history, input, session.builtins);
    let task = (hooks.spawn)(session.agent.args.clone(), body);
    Ok(ActiveTurn {
        session_id: session.id.clone(),
        turn_id: uuid::Uuid::new_v4().to_string(),
        events: task.events,
        runner: task.runner,
        steerer: task.steerer,
        pending: task.pending,
        updated_history: None,
        terminal,
    })
}

/// A new agent for `source`'s project, on `model` or the one it has, carrying
/// its host tools and gate. History and registry are the caller's to decide.
///
/// The rebuilt agent keeps the session's own id: a model change replaces the
/// agent, not the session, and a run that reported a different session after
/// `session/model/set` would rename something the client is still holding.
/// `session/fork` names its new session itself, after this returns.
async fn rebuild_agent(source: &Session, model: Option<String>) -> Result<AgentSession, String> {
    let project = source
        .agent
        .args
        .project_root
        .as_deref()
        .ok_or_else(|| "session has no project root".to_owned())?;
    let mut agent = prepare_agent_session(
        &project.to_string_lossy(),
        Some(model.unwrap_or_else(|| source.agent.model.clone())),
        ProviderOverrides::default(),
        // The source's MCP servers are already connected: reuse them instead
        // of spawning a second copy of every stdio server.
        SessionFlags { require_model: true, skip_mcp: true, ..Default::default() },
        None,
    )?;
    agent.args.session_id = Some(source.id.clone());
    agent.args.host_tools = source.agent.args.host_tools.clone();
    agent.args.host_owns_gate = source.agent.args.host_owns_gate;
    agent.mcp_servers = source.agent.mcp_servers.clone();
    agent.args.mcp_servers = source.agent.args.mcp_servers.clone();
    Ok(agent)
}

/// Wait for the session's active MCP servers to connect, so its first turn
/// (and the `session/start` tool list) already has their tools.
pub(super) async fn await_mcp(agent: &mut AgentSession) {
    if let Some(task) = agent.mcp_task.take() {
        if let Some(outcome) = wait_for_task(task, MCP_START_TIMEOUT).await {
            for failure in &outcome.failed {
                log::warn!("MCP: {failure}");
            }
        }
    }
}

/// How long a session start waits for its MCP servers before going on without
/// the ones still connecting, so one slow server cannot hold the session back.
const MCP_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The task's result, or `None` when it fails or outlasts `limit` (the task is
/// left running detached).
async fn wait_for_task<T>(task: JoinHandle<T>, limit: std::time::Duration) -> Option<T> {
    match tokio::time::timeout(limit, task).await {
        Ok(Ok(value)) => Some(value),
        Ok(Err(e)) => {
            log::warn!("MCP connect task failed: {e}");
            None
        }
        Err(_) => {
            log::warn!("MCP servers still connecting after {}s; starting without them", limit.as_secs());
            None
        }
    }
}

async fn disconnect_all(servers: &crate::core::state::SharedMcpServers) {
    let names: Vec<String> = servers.lock().await.keys().cloned().collect();
    for name in names {
        super::mcp::disconnect(&name, servers).await;
    }
}

/// End an archived session: its MCP servers (unless another session still
/// shares them, as a fork does) and its scratch space.
async fn release_session(session: Session, sessions: &HashMap<String, Session>) {
    let servers = &session.agent.args.mcp_servers;
    if !sessions.values().any(|s| Arc::ptr_eq(&s.agent.args.mcp_servers, servers)) {
        disconnect_all(servers).await;
    }
    let _ = tauri_plugin_agent_tools::workspace::remove_scratch_dir(&session.id).await;
}

fn finish_turn(
    sessions: &mut HashMap<String, Session>,
    turn: ActiveTurn,
    result: Result<Value, String>,
    interrupted: bool,
) -> Result<(), String> {
    let ActiveTurn {
        session_id,
        turn_id,
        steerer,
        updated_history,
        terminal,
        pending,
        ..
    } = turn;
    steerer.abort();
    let session = sessions
        .get_mut(&session_id)
        .ok_or("active session missing")?;
    // Steers the turn never read are carried into the next one.
    if let Ok(mut unread) = pending.try_lock() {
        session.carried_steer.append(&mut unread);
    }
    let persist = if session.ephemeral {
        None
    } else {
        session.agent.args.project_root.as_ref().map(|project| (agent_dir_for(project), None::<Value>))
    };
    let settled = settle_turn(
        &mut session.history,
        updated_history,
        &result,
        interrupted,
        persist.as_ref().map(|(base, metadata)| Persist {
            base,
            session_id: &session.id,
            model: &session.agent.model,
            metadata: metadata.clone(),
        }),
    );
    let (stop_reason, error_message) = (settled.stop_reason, settled.error);
    session.turns += 1;
    // Through the slot the turn reserved, so this cannot be the record that
    // fails to fit: a client that stopped reading gets the outcome when it
    // starts again instead of a process that died holding it.
    terminal.send(json!({
        "jsonrpc":"2.0","method":"turn/completed",
        "params": {
            "sessionId":session_id,"turnId":turn_id,
            "stopReason":if error_message.is_some() { "error" } else { stop_reason },"error":error_message
        }
    }));
    Ok(())
}

/// A `session/start` that finished building off the dispatch loop. The session
/// is not addressable until the loop receives this, so no `turn/start` can name
/// one that is still starting.
struct Started {
    id: Value,
    has_id: bool,
    outcome: Result<(Session, Value), String>,
}

/// Build the session for one `session/start`: configuration, then the MCP
/// servers (bounded by `MCP_START_TIMEOUT`). Runs in its own task, so a slow
/// server delays only this client request, not `session/list`, `turn/interrupt`
/// or an active turn's events.
async fn start_session(request: StartRequest) -> Result<(Session, Value), String> {
    let mut agent = prepare_agent_session(&request.cwd, request.model.clone(), ProviderOverrides::default(), SessionFlags { require_model: true, ..Default::default() }, None)?;
    await_mcp(&mut agent).await;
    Ok(open_session(agent, request).await)
}

/// What a `session/start` asks for, once its params and tools are checked.
struct StartRequest {
    cwd: String,
    model: Option<String>,
    host_tools: HostToolSet,
    host_owns_gate: bool,
    ephemeral: bool,
    builtins: bool,
}

/// A started session around a prepared agent, and its `session/start` reply.
async fn open_session(mut agent: AgentSession, request: StartRequest) -> (Session, Value) {
    let StartRequest { host_tools, host_owns_gate, ephemeral, builtins, .. } = request;
    agent.args.host_tools = host_tools;
    agent.args.host_owns_gate = host_owns_gate;
    let sid = uuid::Uuid::new_v4().to_string();
    // The run reports the session by the id this client holds, not by the
    // private one the agent was built with: provenance and the correlation id
    // are the client's handle on the session, and an id nothing else can name is
    // not a handle.
    agent.args.session_id = Some(sid.clone());
    let session = Session { agent, history: Vec::new(), id: sid.clone(), turns: 0, ephemeral, builtins, carried_steer: Vec::new() };
    let mut result = tools_view(&session).await;
    result["sessionId"] = json!(sid);
    result["model"] = json!(session.agent.model);
    (session, result)
}

type StartFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(Session, Value), String>> + Send>>;

/// What the loop calls out to: building a session and running a turn. The
/// real ones prepare an agent and spawn the engine; tests script them.
struct Hooks {
    start: Box<dyn Fn(StartRequest) -> StartFuture + Send + Sync>,
    spawn: Box<dyn Fn(OrchestrationArgs, Value) -> TurnTask + Send + Sync>,
}

impl Hooks {
    fn real() -> Self {
        Hooks {
            start: Box::new(|request| Box::pin(start_session(request))),
            spawn: Box::new(spawn_turn),
        }
    }
}

/// Register a finished start and make its reply.
fn finish_start(sessions: &mut HashMap<String, Session>, done: Started) -> Option<Value> {
    let Started { id, has_id, outcome } = done;
    let reply = match outcome {
        Ok((session, result)) => {
            sessions.insert(session.id.clone(), session);
            response(&id, result)
        }
        Err(message) => error(&id, -32602, &message),
    };
    has_id.then_some(reply)
}

/// One runtime owns many addressable sessions. All writes share one bounded output queue.
pub async fn serve() -> Result<(), String> {
    let input = input_lines();
    let (out, writer) = mpsc::channel(OUTPUT_CAPACITY);
    let writer = output_lines(writer);
    serve_loop(input, out, Arc::new(Hooks::real())).await?;
    writer
        .join()
        .map_err(|_| "RPC output writer panicked".to_string())?;
    Ok(())
}

/// The dispatch loop, until `input` closes. Every record goes out on `out`.
async fn serve_loop(mut input: mpsc::Receiver<(Vec<u8>, bool)>, out: mpsc::Sender<Value>, hooks: Arc<Hooks>) -> Result<(), String> {
    let (started_tx, mut started_rx) = mpsc::unbounded_channel::<Started>();
    let mut server = RpcServer {
        out: Arc::new(out),
        hooks,
        started_tx,
        initialized: false,
        negotiated: false,
        sessions: HashMap::new(),
        active: HashMap::new(),
    };
    loop {
        tokio::select! {
            Some(done) = started_rx.recv() => {
                if let Some(reply) = finish_start(&mut server.sessions, done) {
                    send_reply(&server.out, reply).await?;
                }
            }
            message = input.recv() => {
                let Some((line, too_long)) = message else { break; };
                server.handle_line(&line, too_long).await?;
            }
            (session_id, message) = next_turn_message(&mut server.active), if !server.active.is_empty() => {
                server.on_turn_message(session_id, message)?;
            }
        }
    }
    server.shutdown().await
}

/// The next record of any running turn, tagged with its session.
async fn next_turn_message(active: &mut HashMap<String, ActiveTurn>) -> (String, Option<TurnMessage>) {
    std::future::poll_fn(|cx| {
        for (session_id, turn) in active.iter_mut() {
            if let std::task::Poll::Ready(message) = turn.events.poll_recv(cx) {
                return std::task::Poll::Ready((session_id.clone(), message));
            }
        }
        std::task::Poll::Pending
    })
    .await
}

/// The state one RPC process serves: its sessions and the turn each one is
/// running. Turns of different sessions run side by side; one session runs
/// one turn at a time.
struct RpcServer {
    out: Arc<mpsc::Sender<Value>>,
    hooks: Arc<Hooks>,
    started_tx: mpsc::UnboundedSender<Started>,
    initialized: bool,
    negotiated: bool,
    sessions: HashMap<String, Session>,
    /// The running turn of each busy session, keyed by session id.
    active: HashMap<String, ActiveTurn>,
}

/// What a method asks the loop to send: a reply, or nothing (a notification,
/// or a reply that comes later, as a `session/start`'s does).
type Reply = Option<Value>;

impl RpcServer {
    fn busy(&self, session_id: &str) -> bool {
        self.active.contains_key(session_id)
    }

    async fn handle_line(&mut self, line: &[u8], too_long: bool) -> Result<(), String> {
        if too_long {
            return send_reply(&self.out, error(&Value::Null, -32600, "Input line exceeds max_line_bytes")).await;
        }
        let request: Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(_) => return send_reply(&self.out, error(&Value::Null, -32700, "Parse error")).await,
        };
        let has_id = request.get("id").is_some();
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = &request["params"];
        if request["jsonrpc"] != "2.0" || method.is_empty() {
            return send_reply(&self.out, error(&id, -32600, "Invalid Request")).await;
        }
        if method == "initialize" {
            let reply = self.initialize(&id, params);
            return send_reply(&self.out, reply).await;
        }
        if method == "initialized" && self.negotiated && !has_id {
            self.initialized = true;
            return Ok(());
        }
        if !self.initialized {
            // A notification has no id to answer; replying would send the
            // client a response it never asked for.
            if has_id {
                send_reply(&self.out, error(&id, -32002, "Server not initialized")).await?;
            }
            return Ok(());
        }
        let reply = self.handle_request(&id, has_id, method, params).await?;
        match reply {
            Some(reply) if has_id => send_reply(&self.out, reply).await,
            _ => Ok(()),
        }
    }

    /// A new handshake replaces the previous one; a failed negotiation cannot
    /// authorize `initialized` or methods.
    fn initialize(&mut self, id: &Value, params: &Value) -> Value {
        self.negotiated = false;
        self.initialized = false;
        match serde_json::from_value::<InitializeParams>(params.clone()) {
            Ok(init) if init.protocol_version == PROTOCOL_VERSION && !init.client_info.name.is_empty() && !init.client_info.version.is_empty() => {
                self.negotiated = true;
                // The caps a content-part array is held to -- a `turn/start`
                // input's and a `tool/respond` content's, the same limits
                // `init` advertises to a stream-json client. A client that
                // sends an image is sending bytes into a channel with no
                // backpressure, so it learns the limits from the handshake
                // rather than by having a message rejected.
                response(id, json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "serverInfo": {"name":"jan","version":env!("CARGO_PKG_VERSION")},
                    "capabilities": {"session":true,"turn":true},
                    "input_content_parts": super::run_report::InputContentParts::current(),
                }))
            }
            _ => error(id, -32602, "Unsupported protocol version or malformed clientInfo"),
        }
    }

    async fn handle_request(&mut self, id: &Value, has_id: bool, method: &str, params: &Value) -> Result<Reply, String> {
        Ok(match method {
            "session/start" => self.session_start(id, has_id, params),
            "session/tools/get" => Some(self.tools_get(id, params).await),
            "session/tools/set" => Some(self.tools_set(id, params).await),
            "session/model/set" => Some(self.model_set(id, params).await),
            "session/reset" => Some(self.reset(id, params).await),
            "tool/respond" => Some(self.tool_respond(id, params).await),
            "session/list" => Some(self.list(id, params)),
            "session/resume" => Some(self.resume(id, params)),
            "session/fork" => Some(self.fork(id, params).await),
            "session/archive" => Some(self.archive(id, params).await),
            "turn/start" => Some(self.turn_start(id, params)),
            "turn/steer" => Some(self.turn_steer(id, params).await),
            "turn/interrupt" => Some(self.turn_interrupt(id, params).await?),
            "permission/respond" => Some(self.permission_respond(id, params).await),
            _ => Some(error(id, -32601, "Method not found")),
        })
    }

    fn session_start(&mut self, id: &Value, has_id: bool, params: &Value) -> Reply {
        match serde_json::from_value::<SessionStartParams>(params.clone()) {
            Err(_) => Some(error(id, -32602, "session/start requires cwd and supported options")),
            Ok(start) if !std::path::Path::new(&start.cwd).is_dir() => Some(error(id, -32602, "cwd is not a directory")),
            // Declared before the session is built: a tool set the host got
            // wrong is refused before anything is spent.
            Ok(start) => match declare_tools(start.tools) {
                Err(message) => Some(invalid_tools(id, &message)),
                Ok(host_tools) => {
                    // Built in its own task; the reply comes back through
                    // `started_rx`, so the loop keeps serving meanwhile.
                    let tx = self.started_tx.clone();
                    let reply_id = id.clone();
                    let owns_gate = start.permissions == PermissionOwner::Host;
                    let pending_start = (self.hooks.start)(StartRequest { cwd: start.cwd, model: start.model, host_tools, host_owns_gate: owns_gate, ephemeral: start.ephemeral, builtins: start.builtins });
                    tokio::spawn(async move {
                        let outcome = pending_start.await;
                        let _ = tx.send(Started { id: reply_id, has_id, outcome });
                    });
                    None
                }
            },
        }
    }

    async fn tools_get(&self, id: &Value, params: &Value) -> Value {
        match serde_json::from_value::<SessionIdParams>(params.clone()) {
            Err(_) => error(id, -32602, "session/tools/get requires sessionId"),
            Ok(SessionIdParams { session_id: sid }) => match self.sessions.get(&sid) {
                Some(session) => response(id, tools_view(session).await),
                None => error(id, -32602, UNKNOWN_SESSION),
            },
        }
    }

    async fn tools_set(&mut self, id: &Value, params: &Value) -> Value {
        match serde_json::from_value::<SessionToolsSetParams>(params.clone()) {
            Err(_) => error(id, -32602, "session/tools/set requires sessionId and tools"),
            Ok(set) if !self.sessions.contains_key(&set.session_id) => error(id, -32602, UNKNOWN_SESSION),
            Ok(set) if self.busy(&set.session_id) => turn_active(id),
            Ok(set) => match declare_tools(set.tools) {
                Err(message) => invalid_tools(id, &message),
                Ok(host_tools) => {
                    let session = self.sessions.get_mut(&set.session_id).expect("checked");
                    session.agent.args.host_tools = host_tools;
                    response(id, tools_view(session).await)
                }
            },
        }
    }

    async fn model_set(&mut self, id: &Value, params: &Value) -> Value {
        match serde_json::from_value::<SessionModelSetParams>(params.clone()) {
            Err(_) => error(id, -32602, "session/model/set requires sessionId and model"),
            Ok(set) if !self.sessions.contains_key(&set.session_id) => error(id, -32602, UNKNOWN_SESSION),
            Ok(set) if self.busy(&set.session_id) => turn_active(id),
            Ok(set) if set.model.trim().is_empty() => error(id, -32602, "model must not be empty"),
            Ok(set) => {
                // Refuse a model no configured provider serves. The turn would
                // fail closed on it too -- nothing goes out on the session's
                // behalf -- but this is the point at which a client can still be
                // told, and the session must not be left pinned to a model that
                // cannot serve it, which the next turn would report as a failure
                // of the client's own input.
                let provider_configs = self.sessions.get(&set.session_id).expect("checked").agent.args.provider_configs.clone();
                match crate::core::agent::upstream::resolve_upstream_for_model(&set.model, provider_configs).await {
                    Err(message) => error(id, -32602, &message),
                    Ok(_) => {
                        let session = self.sessions.get_mut(&set.session_id).expect("checked");
                        match rebuild_agent(session, Some(set.model)).await {
                            Ok(agent) => {
                                // The same registry: nothing is pending between
                                // turns, and keeping it keeps one per session.
                                let registry = Arc::clone(&session.agent.args.host_tool_requests);
                                session.agent = agent;
                                session.agent.args.host_tool_requests = registry;
                                response(id, json!({"model":session.agent.model}))
                            }
                            Err(message) => error(id, -32602, &message),
                        }
                    }
                }
            }
        }
    }

    async fn reset(&mut self, id: &Value, params: &Value) -> Value {
        match serde_json::from_value::<SessionIdParams>(params.clone()) {
            Err(_) => error(id, -32602, "session/reset requires sessionId"),
            Ok(SessionIdParams { session_id: sid }) if !self.sessions.contains_key(&sid) => error(id, -32602, UNKNOWN_SESSION),
            Ok(SessionIdParams { session_id: sid }) if self.busy(&sid) => turn_active(id),
            Ok(SessionIdParams { session_id: sid }) => {
                let session = self.sessions.get_mut(&sid).expect("checked");
                session.history.clear();
                response(id, tools_view(session).await)
            }
        }
    }

    /// A host tool answer. It names only its request, so it goes to whichever
    /// running turn issued that request; only a running turn can be waiting on
    /// a host, so with none a reply is as late as one already answered.
    async fn tool_respond(&self, id: &Value, params: &Value) -> Value {
        let respond = match serde_json::from_value::<ToolRespondParams>(params.clone()) {
            Err(_) => return error(id, -32602, "tool/respond requires requestId and content (a string or content parts)"),
            Ok(respond) => respond,
        };
        let (request_id, result) = match host_result(respond) {
            Err(message) => return error(id, -32602, &message),
            Ok(answer) => answer,
        };
        for session_id in self.active.keys() {
            let Some(session) = self.sessions.get(session_id) else { continue };
            let registry = Arc::clone(&session.agent.args.host_tool_requests);
            if registry.lock().await.contains_key(&request_id) {
                return match crate::core::agent::host_tools::respond(&registry, &request_id, Ok(result)).await {
                    Ok(()) => response(id, json!({})),
                    Err(message) => error_data(id, -32602, &message, json!({"kind":"not_pending"})),
                };
            }
        }
        error_data(
            id,
            -32602,
            &format!("no host tool request '{request_id}' is pending (answered, cancelled, or never issued)"),
            json!({"kind":"not_pending"}),
        )
    }

    /// Takes no params, so the only shape it accepts is none: an object, or the
    /// omitted-params `null` JSON-RPC allows. As a list request it is also the
    /// one method where a scalar in place of params is a client bug worth naming.
    fn list(&self, id: &Value, params: &Value) -> Value {
        match params {
            Value::Object(_) | Value::Null => response(id, json!({"sessions":self.sessions.values().map(|s| json!({"id":s.id,"model":s.agent.model,"turns":s.turns,"hostTools":s.agent.args.host_tools.len()})).collect::<Vec<_>>()})),
            _ => error(id, -32602, "session/list takes no params"),
        }
    }

    fn resume(&self, id: &Value, params: &Value) -> Value {
        match serde_json::from_value::<SessionIdParams>(params.clone()) {
            Err(_) => error(id, -32602, "session/resume requires sessionId"),
            Ok(SessionIdParams { session_id: sid }) => match self.sessions.get(&sid) {
                Some(session) => response(id, json!({"sessionId":sid,"model":session.agent.model,"turns":session.turns})),
                None => error(id, -32602, "unknown sessionId (RPC sessions belong to their process)"),
            },
        }
    }

    async fn fork(&mut self, id: &Value, params: &Value) -> Value {
        match serde_json::from_value::<SessionIdParams>(params.clone()) {
            Err(_) => error(id, -32602, "unknown sessionId"),
            Ok(SessionIdParams { session_id: sid }) if self.busy(&sid) => error(id, -32001, "session busy"),
            Ok(SessionIdParams { session_id: sid }) if self.sessions.contains_key(&sid) => {
                let source = self.sessions.get(&sid).expect("checked");
                // A fresh registry (from the rebuild): the fork is its own
                // session, and a reply must never cross into it.
                match rebuild_agent(source, None).await {
                    Ok(mut agent) => {
                        let fork = uuid::Uuid::new_v4().to_string();
                        // The fork is its own session, so it reports its own id.
                        agent.args.session_id = Some(fork.clone());
                        let history = source.history.clone();
                        let ephemeral = source.ephemeral;
                        let builtins = source.builtins;
                        self.sessions.insert(fork.clone(), Session { agent, history, id: fork.clone(), turns: 0, ephemeral, builtins, carried_steer: Vec::new() });
                        response(id, json!({"sessionId":fork}))
                    }
                    Err(message) => error(id, -32602, &message),
                }
            }
            Ok(_) => error(id, -32602, "unknown sessionId"),
        }
    }

    async fn archive(&mut self, id: &Value, params: &Value) -> Value {
        match serde_json::from_value::<SessionIdParams>(params.clone()) {
            Err(_) => error(id, -32602, "unknown sessionId"),
            Ok(SessionIdParams { session_id: sid }) if self.busy(&sid) => error(id, -32001, "session busy"),
            Ok(SessionIdParams { session_id: sid }) if self.sessions.contains_key(&sid) => {
                let session = self.sessions.remove(&sid).expect("checked");
                release_session(session, &self.sessions).await;
                response(id, json!({}))
            }
            Ok(_) => error(id, -32602, "unknown sessionId"),
        }
    }

    fn turn_start(&mut self, id: &Value, params: &Value) -> Value {
        let TurnStartParams { session_id, input } = match serde_json::from_value::<TurnStartParams>(params.clone()) {
            Err(_) => return error(id, -32602, "turn/start requires sessionId and input"),
            Ok(start) => start,
        };
        if self.busy(&session_id) {
            return error(id, -32001, "another turn is active; retry after turn/completed");
        }
        let parsed = json!({"type":"user","content":input});
        let content = if let Some(text) = input.as_str() {
            parse_input_line(&json!({"type":"user","text":text}).to_string()).map(|_| Value::String(text.to_owned()))
        } else if input.is_array() {
            parse_input_line(&parsed.to_string()).map(|_| input)
        } else {
            Err("input must be text or content parts".to_string())
        };
        match (self.sessions.get_mut(&session_id), content) {
            (Some(session), Ok(content)) => match start_turn(session, content, &self.out, &self.hooks) {
                Ok(turn) => {
                    let tid = turn.turn_id.clone();
                    self.active.insert(session_id, turn);
                    response(id, json!({"turnId":tid}))
                }
                // The turn would have no room to report its outcome on, so it
                // is refused while the client drains what is already queued.
                Err(message) => error(id, -32001, &message),
            },
            (None, _) => error(id, -32602, "unknown sessionId"),
            (_, Err(message)) => error(id, -32602, &message),
        }
    }

    async fn turn_steer(&self, id: &Value, params: &Value) -> Value {
        const REFUSED: &str = "turn/steer requires an active session and nonempty input";
        match serde_json::from_value::<TurnSteerParams>(params.clone()) {
            Err(_) => error(id, -32602, REFUSED),
            Ok(TurnSteerParams { session_id: sid, input: text }) => match self.active.get(&sid) {
                Some(turn) if !text.trim().is_empty() => {
                    let mut pending = turn.pending.lock().await;
                    if pending.len() >= super::stream_input::MAX_QUEUED {
                        error_data(id, -32000, &super::stream_input::queue_full(), json!({"kind":"queue_full","retryable":true}))
                    } else {
                        pending.push(json!({"role":"user","content":neutralize_user_content(json!(text))}));
                        response(id, json!({}))
                    }
                }
                _ => error(id, -32602, REFUSED),
            },
        }
    }

    async fn turn_interrupt(&mut self, id: &Value, params: &Value) -> Result<Value, String> {
        let turn = match serde_json::from_value::<SessionIdParams>(params.clone()) {
            Ok(SessionIdParams { session_id: sid }) => self.active.remove(&sid),
            Err(_) => None,
        };
        let Some(turn) = turn else {
            return Ok(error(id, -32602, "no active turn for sessionId"));
        };
        let sid = turn.session_id.clone();
        turn.runner.abort();
        if let Some(session) = self.sessions.get_mut(&sid) {
            session.agent.permission_requests.lock().await.clear();
        }
        release_host_requests(self.sessions.get(&sid), &turn, "interrupted", &self.out).await?;
        finish_turn(&mut self.sessions, turn, Err("interrupted".to_owned()), true)?;
        Ok(response(id, json!({})))
    }

    /// A permission answer names only its request, so it goes to whichever
    /// running turn's gate is waiting on that id.
    async fn permission_respond(&self, id: &Value, params: &Value) -> Value {
        let (request_id, decision) = match (self.active.is_empty(), serde_json::from_value::<PermissionResponseParams>(params.clone())) {
            (false, Ok(PermissionResponseParams { request_id, decision })) => (request_id, decision),
            _ => return error(id, -32602, "permission/respond requires an active turn and requestId"),
        };
        let Some(decision) = parse_decision(decision.as_str()) else {
            return error(id, -32602, "invalid permission decision");
        };
        for session_id in self.active.keys() {
            let Some(session) = self.sessions.get(session_id) else { continue };
            if let Some(sender) = session.agent.permission_requests.lock().await.remove(&request_id) {
                let _ = sender.send(decision);
                return response(id, json!({}));
            }
        }
        error(id, -32602, "no permission request is pending")
    }

    fn on_turn_message(&mut self, session_id: String, message: Option<TurnMessage>) -> Result<(), String> {
        let Some(message) = message else {
            // The run's task is gone without an outcome: a panic in the engine,
            // or an abort this loop did not make. The turn still owes the client
            // a terminal record, and this arm would be ready with `None` on
            // every pass until it got one.
            let turn = self.active.remove(&session_id).expect("active");
            return finish_turn(&mut self.sessions, turn, Err("the run ended without an outcome".to_owned()), false);
        };
        match message {
            TurnMessage::Event(event) => {
                let event = *event;
                let turn = self.active.get_mut(&session_id).expect("active");
                if let StreamEvent::MessagesUpdated { messages } = &event {
                    turn.updated_history = Some(messages.clone());
                }
                let wire = serde_json::to_value(&event).map_err(|e| e.to_string())?;
                let method = format!("item/{}", wire["type"].as_str().ok_or("event has no tag")?);
                // Each turn's terminal record has its own slot, so this bound
                // only covers the streamed events: when the client is not
                // reading them, the turn ends rather than accumulating
                // unbounded model deltas.
                if self.out.capacity() == 0 {
                    let turn = self.active.remove(&session_id).expect("active");
                    turn.runner.abort();
                    finish_turn(&mut self.sessions, turn, Err("RPC output queue overloaded".to_owned()), false)
                } else {
                    notify(&self.out, &method, json!({"sessionId":turn.session_id,"turnId":turn.turn_id,"event":wire}))
                }
            }
            TurnMessage::Finished(result) => {
                let turn = self.active.remove(&session_id).expect("active");
                finish_turn(&mut self.sessions, turn, result, false)
            }
        }
    }

    /// stdin closed: stop every running turn.
    async fn shutdown(mut self) -> Result<(), String> {
        let running: Vec<String> = self.active.keys().cloned().collect();
        for session_id in running {
            let turn = self.active.remove(&session_id).expect("listed");
            turn.runner.abort();
            release_host_requests(self.sessions.get(&turn.session_id), &turn, "client_gone", &self.out).await?;
            // stdin closing is not stdout closing: a client that asked the
            // process to end but keeps reading still gets the record that says
            // its turn ended, which is the one thing it cannot infer from the
            // channel closing. The turn was stopped by the client, so that is
            // what the record reports, and it goes out on the slot the turn
            // reserved - the writer drains the queue before joining.
            finish_turn(&mut self.sessions, turn, Ok(Value::Null), true)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::cli::PermissionRegistry;
    use crate::core::cli::stream_input::{MAX_IMAGES, MAX_IMAGE_BYTES};
    use crate::core::cli::turn_host::{forward_events, host_names, pump_turn};

    #[tokio::test]
    async fn a_failed_start_replies_with_the_error_and_registers_nothing() {
        let mut sessions = HashMap::new();
        let reply = finish_start(&mut sessions, Started { id: json!(7), has_id: true, outcome: Err("boom".into()) }).unwrap();
        assert_eq!(reply["id"], json!(7));
        assert_eq!(reply["error"]["code"], json!(-32602));
        assert_eq!(reply["error"]["message"], json!("boom"));
        assert!(sessions.is_empty());
        assert!(finish_start(&mut sessions, Started { id: Value::Null, has_id: false, outcome: Err("x".into()) }).is_none());
    }

    // ── the dispatch loop, driven end to end with scripted turns ──────────

    type Turns = Arc<std::sync::Mutex<Vec<(Value, mpsc::Sender<TurnMessage>, PermissionRegistry)>>>;

    /// Hooks whose sessions are real agents for a temp project (no model, so
    /// nothing can reach a provider) and whose turns are channels the test
    /// plays the engine on.
    fn scripted_hooks(turns: Turns) -> Hooks {
        Hooks {
            start: Box::new(|request: StartRequest| {
                Box::pin(async move {
                    let agent = prepare_agent_session(&request.cwd, None, ProviderOverrides::default(), SessionFlags::default(), None)?;
                    Ok(open_session(agent, request).await)
                })
            }),
            spawn: Box::new(move |args: OrchestrationArgs, body| {
                let (tx, events) = mpsc::channel(16);
                turns.lock().unwrap().push((body, tx, args.permission_requests.clone()));
                TurnTask {
                    events,
                    runner: tokio::spawn(std::future::pending()),
                    steerer: tokio::spawn(std::future::pending()),
                    pending: Default::default(),
                }
            }),
        }
    }

    struct Rpc {
        input: mpsc::Sender<(Vec<u8>, bool)>,
        output: mpsc::Receiver<Value>,
        turns: Turns,
        task: JoinHandle<Result<(), String>>,
        project: tempfile::TempDir,
        next_id: u64,
    }

    impl Rpc {
        fn start() -> Self {
            let (input, in_rx) = mpsc::channel(16);
            let (out_tx, output) = mpsc::channel(OUTPUT_CAPACITY);
            let turns: Turns = Default::default();
            let task = tokio::spawn(serve_loop(in_rx, out_tx, Arc::new(scripted_hooks(turns.clone()))));
            Rpc { input, output, turns, task, project: tempfile::tempdir().unwrap(), next_id: 100 }
        }

        async fn send(&self, record: Value) {
            self.input.send((record.to_string().into_bytes(), false)).await.unwrap();
        }

        async fn recv(&mut self) -> Value {
            tokio::time::timeout(std::time::Duration::from_secs(10), self.output.recv()).await.expect("no record").expect("loop gone")
        }

        /// Send a request and return its reply, collecting notifications that
        /// arrive first into `seen`.
        async fn call_seen(&mut self, method: &str, params: Value, seen: &mut Vec<Value>) -> Value {
            self.next_id += 1;
            let id = self.next_id;
            self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).await;
            loop {
                let record = self.recv().await;
                if record["id"] == id {
                    return record;
                }
                seen.push(record);
            }
        }

        async fn call(&mut self, method: &str, params: Value) -> Value {
            let mut seen = Vec::new();
            let reply = self.call_seen(method, params, &mut seen).await;
            assert!(seen.is_empty(), "unexpected records before the reply: {seen:?}");
            reply
        }

        async fn handshake(&mut self) {
            let reply = self.call("initialize", json!({"protocolVersion":PROTOCOL_VERSION,"clientInfo":{"name":"t","version":"1"}})).await;
            assert_eq!(reply["result"]["protocolVersion"], PROTOCOL_VERSION, "{reply}");
            self.send(json!({"jsonrpc":"2.0","method":"initialized"})).await;
        }

        async fn session(&mut self) -> String {
            let cwd = self.project.path().to_string_lossy().into_owned();
            let reply = self.call("session/start", json!({"cwd":cwd,"ephemeral":true})).await;
            reply["result"]["sessionId"].as_str().unwrap_or_else(|| panic!("{reply}")).to_owned()
        }

        async fn turn(&self, n: usize) -> mpsc::Sender<TurnMessage> {
            for _ in 0..500 {
                if let Some((_, tx, _)) = self.turns.lock().unwrap().get(n) {
                    return tx.clone();
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("turn {n} never started");
        }

        async fn stop(self) {
            drop(self.input);
            tokio::time::timeout(std::time::Duration::from_secs(10), self.task).await.expect("loop did not stop").unwrap().unwrap();
        }
    }

    /// Runs `test` on its own runtime inside a temp home, so the session's
    /// agent config never reads or writes the real one.
    fn with_rpc<F, Fut>(test: F)
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        crate::core::agent::global_config::with_temp_home(|_| {
            tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap().block_on(test());
        });
    }

    fn token(text: &str) -> TurnMessage {
        TurnMessage::Event(Box::new(StreamEvent::Token { text: text.into() }))
    }

    #[test]
    fn methods_wait_for_the_handshake() {
        with_rpc(|| async {
            let mut rpc = Rpc::start();
            let early = rpc.call("session/list", json!({})).await;
            assert_eq!(early["error"]["code"], -32002);
            rpc.send(json!({"jsonrpc":"2.0","method":"initialized"})).await;
            let bad = rpc.call("initialize", json!({"protocolVersion":999,"clientInfo":{"name":"t","version":"1"}})).await;
            assert_eq!(bad["error"]["code"], -32602);
            rpc.handshake().await;
            assert_eq!(rpc.call("session/list", json!({})).await["result"]["sessions"], json!([]));
            assert_eq!(rpc.call("nope/nope", json!({})).await["error"]["code"], -32601);
            rpc.stop().await;
        });
    }

    #[test]
    fn a_turn_streams_its_events_and_completes() {
        with_rpc(|| async {
            let mut rpc = Rpc::start();
            rpc.handshake().await;
            let sid = rpc.session().await;
            let listed = rpc.call("session/list", json!({})).await;
            assert_eq!(listed["result"]["sessions"][0]["id"], sid.as_str());
            let started = rpc.call("turn/start", json!({"sessionId":sid,"input":"hello"})).await;
            let tid = started["result"]["turnId"].as_str().expect("turn id").to_owned();
            let turn = rpc.turn(0).await;
            let body = rpc.turns.lock().unwrap()[0].0.clone();
            assert_eq!(body["messages"].as_array().unwrap().last().unwrap()["content"], "hello");
            turn.send(token("hi")).await.unwrap();
            let event = rpc.recv().await;
            assert_eq!(event["method"], "item/token");
            assert_eq!(event["params"]["sessionId"], sid.as_str());
            assert_eq!(event["params"]["turnId"], tid.as_str());
            turn.send(TurnMessage::Finished(Ok(json!({})))).await.unwrap();
            let done = rpc.recv().await;
            assert_eq!(done["method"], "turn/completed");
            assert_eq!(done["params"]["turnId"], tid.as_str());
            assert_eq!(done["params"]["stopReason"], "completed");
            let resumed = rpc.call("session/resume", json!({"sessionId":sid})).await;
            assert_eq!(resumed["result"]["turns"], 1);
            rpc.stop().await;
        });
    }

    #[test]
    fn a_busy_session_refuses_changes_and_a_second_turn() {
        with_rpc(|| async {
            let mut rpc = Rpc::start();
            rpc.handshake().await;
            let sid = rpc.session().await;
            rpc.call("turn/start", json!({"sessionId":sid,"input":"one"})).await;
            rpc.turn(0).await;
            let again = rpc.call("turn/start", json!({"sessionId":sid,"input":"two"})).await;
            assert_eq!(again["error"]["code"], -32001);
            let reset = rpc.call("session/reset", json!({"sessionId":sid})).await;
            assert_eq!(reset["error"]["data"]["kind"], "turn_active");
            let tools = rpc.call("session/tools/set", json!({"sessionId":sid,"tools":[]})).await;
            assert_eq!(tools["error"]["data"]["kind"], "turn_active");
            assert_eq!(rpc.call("session/archive", json!({"sessionId":sid})).await["error"]["code"], -32001);
            assert_eq!(rpc.call("session/fork", json!({"sessionId":sid})).await["error"]["code"], -32001);
            assert_eq!(rpc.turns.lock().unwrap().len(), 1);
            rpc.stop().await;
        });
    }

    #[test]
    fn steer_and_interrupt_reach_the_running_turn() {
        with_rpc(|| async {
            let mut rpc = Rpc::start();
            rpc.handshake().await;
            let sid = rpc.session().await;
            let tid = rpc.call("turn/start", json!({"sessionId":sid,"input":"one"})).await["result"]["turnId"].clone();
            let turn = rpc.turn(0).await;
            assert_eq!(rpc.call("turn/steer", json!({"sessionId":sid,"input":"also this"})).await["result"], json!({}));
            assert_eq!(rpc.call("turn/steer", json!({"sessionId":"other","input":"x"})).await["error"]["code"], -32602);
            assert_eq!(rpc.call("turn/interrupt", json!({"sessionId":"other"})).await["error"]["code"], -32602);
            let mut seen = Vec::new();
            let reply = rpc.call_seen("turn/interrupt", json!({"sessionId":sid}), &mut seen).await;
            assert_eq!(reply["result"], json!({}));
            // The terminal record precedes or follows the reply; either way it says interrupted.
            let done = match seen.iter().find(|r| r["method"] == "turn/completed") {
                Some(done) => done.clone(),
                None => rpc.recv().await,
            };
            assert_eq!(done["params"]["turnId"], tid);
            assert_eq!(done["params"]["stopReason"], "interrupted");
            tokio::time::timeout(std::time::Duration::from_secs(5), turn.closed()).await.expect("turn kept alive");
            // The unread steer opens the next turn.
            rpc.call("turn/start", json!({"sessionId":sid,"input":"two"})).await;
            rpc.turn(1).await;
            let body = rpc.turns.lock().unwrap()[1].0.clone();
            let contents: Vec<Value> = body["messages"].as_array().unwrap().iter().map(|m| m["content"].clone()).collect();
            assert!(contents.iter().any(|c| c == "also this"), "{contents:?}");
            rpc.stop().await;
        });
    }

    #[test]
    fn answers_without_a_running_turn_are_refused() {
        with_rpc(|| async {
            let mut rpc = Rpc::start();
            rpc.handshake().await;
            rpc.session().await;
            let permission = rpc.call("permission/respond", json!({"requestId":"perm-1","decision":"allow_once"})).await;
            assert_eq!(permission["error"]["code"], -32602);
            let tool = rpc.call("tool/respond", json!({"requestId":"host-1","content":"x"})).await;
            assert_eq!(tool["error"]["data"]["kind"], "not_pending");
            rpc.stop().await;
        });
    }

    /// Turns of different sessions run side by side: each streams under its
    /// own ids and completes on its own, and an interrupt stops only its own.
    #[test]
    fn turns_in_two_sessions_run_concurrently() {
        with_rpc(|| async {
            let mut rpc = Rpc::start();
            rpc.handshake().await;
            let a = rpc.session().await;
            let b = rpc.session().await;
            let tid_a = rpc.call("turn/start", json!({"sessionId":a,"input":"one"})).await["result"]["turnId"].clone();
            let turn_a = rpc.turn(0).await;
            let started_b = rpc.call("turn/start", json!({"sessionId":b,"input":"two"})).await;
            let tid_b = started_b["result"]["turnId"].clone();
            assert!(tid_b.is_string(), "{started_b}");
            let turn_b = rpc.turn(1).await;
            // Still one turn per session.
            assert_eq!(rpc.call("turn/start", json!({"sessionId":b,"input":"three"})).await["error"]["code"], -32001);
            // A busy session does not block changes to an idle one.
            turn_b.send(token("from b")).await.unwrap();
            let event = rpc.recv().await;
            assert_eq!(event["params"]["sessionId"], b.as_str());
            assert_eq!(event["params"]["turnId"], tid_b);
            turn_a.send(token("from a")).await.unwrap();
            let event = rpc.recv().await;
            assert_eq!(event["params"]["sessionId"], a.as_str());
            turn_b.send(TurnMessage::Finished(Ok(json!({})))).await.unwrap();
            let done = rpc.recv().await;
            assert_eq!(done["method"], "turn/completed");
            assert_eq!(done["params"]["turnId"], tid_b);
            assert_eq!(rpc.call("session/reset", json!({"sessionId":b})).await["result"].is_object(), true);
            let mut seen = Vec::new();
            assert_eq!(rpc.call_seen("turn/interrupt", json!({"sessionId":a}), &mut seen).await["result"], json!({}));
            let done = match seen.iter().find(|r| r["method"] == "turn/completed") {
                Some(done) => done.clone(),
                None => rpc.recv().await,
            };
            assert_eq!(done["params"]["turnId"], tid_a);
            assert_eq!(done["params"]["stopReason"], "interrupted");
            rpc.stop().await;
        });
    }

    /// A permission answer names only its request; it reaches the gate of the
    /// session that asked, whichever turns are running.
    #[test]
    fn a_permission_answer_reaches_the_session_that_asked() {
        with_rpc(|| async {
            let mut rpc = Rpc::start();
            rpc.handshake().await;
            let a = rpc.session().await;
            let b = rpc.session().await;
            rpc.call("turn/start", json!({"sessionId":a,"input":"one"})).await;
            rpc.call("turn/start", json!({"sessionId":b,"input":"two"})).await;
            rpc.turn(1).await;
            let (gate_tx, gate_rx) = tokio::sync::oneshot::channel();
            {
                let registry = rpc.turns.lock().unwrap()[1].2.clone();
                registry.lock().await.insert("perm-b".into(), gate_tx);
            }
            let reply = rpc.call("permission/respond", json!({"requestId":"perm-b","decision":"allow_once"})).await;
            assert_eq!(reply["result"], json!({}), "{reply}");
            assert!(tokio::time::timeout(std::time::Duration::from_secs(5), gate_rx).await.expect("gate never answered").is_ok());
            assert_eq!(rpc.call("permission/respond", json!({"requestId":"perm-b","decision":"allow_once"})).await["error"]["code"], -32602);
            rpc.stop().await;
        });
    }

    #[tokio::test]
    async fn slow_task_times_out_and_finished_task_returns() {
        let slow: JoinHandle<u8> = tokio::spawn(std::future::pending());
        let limit = std::time::Duration::from_millis(30);
        assert_eq!(wait_for_task(slow, limit).await, None);
        let quick: JoinHandle<u8> = tokio::spawn(async { 7 });
        assert_eq!(wait_for_task(quick, std::time::Duration::from_secs(5)).await, Some(7));
    }

    /// What the runner does: pump while the engine runs, then drain the rest.
    async fn relay(burst: usize, events: mpsc::Sender<TurnMessage>) -> Result<Value, String> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        // Bursts of 50 with a yield between them: some are relayed while the
        // engine is still running, the last is drained after it returns.
        let engine = async {
            for i in 0..burst {
                tx.send(StreamEvent::Token { text: i.to_string() }).unwrap();
                if i % 50 == 49 {
                    tokio::task::yield_now().await;
                }
            }
            Ok(json!("done"))
        };
        let result = pump_turn(engine, &mut rx, &events).await;
        drop(tx);
        forward_events(&mut rx, &events).await?;
        result
    }

    #[tokio::test]
    async fn a_burst_larger_than_the_turn_queue_reaches_a_slow_reader_in_order() {
        let (events, mut receiver) = mpsc::channel(4);
        let reader = tokio::spawn(async move {
            let mut seen = Vec::new();
            while let Some(message) = receiver.recv().await {
                if let TurnMessage::Event(event) = message {
                    if let StreamEvent::Token { text } = *event {
                        seen.push(text);
                    }
                }
                tokio::task::yield_now().await;
            }
            seen
        });
        assert_eq!(relay(200, events).await.unwrap(), json!("done"));
        let expected: Vec<String> = (0..200).map(|i| i.to_string()).collect();
        assert_eq!(reader.await.unwrap(), expected);
    }

    #[tokio::test]
    async fn a_dispatcher_that_dropped_the_turn_ends_it() {
        let (events, receiver) = mpsc::channel(1);
        drop(receiver);
        assert!(relay(3, events).await.unwrap_err().contains("closed"));
    }

    fn image(decoded: usize) -> Value {
        let payload = "A".repeat(decoded.div_ceil(3) * 4);
        json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{payload}")}})
    }

    fn respond_params(content: Value) -> ToolRespondParams {
        serde_json::from_value(json!({"requestId":"host-1","content":content})).expect("parses")
    }

    #[test]
    fn a_text_result_is_the_whole_answer() {
        let (id, result) = host_result(respond_params(json!("moved"))).unwrap();
        assert_eq!(id, "host-1");
        assert_eq!(result, HostToolResult { content: "moved".into(), parts: None, details: None, is_error: false });
    }

    /// Parts pass through verbatim; the text summary is what hooks and the
    /// `tool_result` event see.
    #[test]
    fn a_parts_result_keeps_its_parts_and_summarizes_its_text() {
        let parts = json!([{"type":"text","text":"a"},image(3),{"type":"text","text":"b"}]);
        let params: ToolRespondParams = serde_json::from_value(json!({
            "requestId":"host-1","content":parts,"isError":true,"details":{"k":1}
        })).unwrap();
        let (_, result) = host_result(params).unwrap();
        assert_eq!(result.content, "a\nb");
        assert_eq!(Value::Array(result.parts.unwrap()), parts);
        assert_eq!(result.details, Some(json!({"k":1})));
        assert!(result.is_error);
    }

    #[test]
    fn result_parts_are_held_to_the_user_message_caps() {
        // Unpadded base64 decodes in whole 3-byte groups, so the largest image
        // at the cap is its largest multiple of 3.
        let at_cap = MAX_IMAGE_BYTES / 3 * 3;
        assert!(check_result_parts(&[image(at_cap)]).is_ok());
        assert!(check_result_parts(&[image(at_cap + 3)]).unwrap_err().contains("byte cap"));
        assert!(check_result_parts(&vec![image(3); MAX_IMAGES + 1]).unwrap_err().contains("images"));
        assert!(check_result_parts(&vec![image(at_cap); 3]).unwrap_err().contains("total"));
        assert!(check_result_parts(&[]).is_err());
        assert!(check_result_parts(&[json!({"type":"text","text":" "})]).is_err());
        assert!(check_result_parts(&[json!({"type":"audio"})]).unwrap_err().contains("audio"));
        let bmp = json!({"type":"image_url","image_url":{"url":"data:image/bmp;base64,AA=="}});
        assert!(check_result_parts(&[bmp]).is_err());
    }

    #[test]
    fn content_that_is_neither_text_nor_parts_is_a_params_error() {
        assert!(serde_json::from_value::<ToolRespondParams>(json!({"requestId":"h","content":7})).is_err());
        assert!(serde_json::from_value::<ToolRespondParams>(json!({"requestId":"h"})).is_err());
    }

    #[test]
    fn a_declaration_error_names_the_entry_or_the_rule() {
        let set = declare_tools(vec![json!({"name":"camera","capability":"read"})]).unwrap();
        assert_eq!(host_names(&set), ["host__camera"]);
        assert!(declare_tools(vec![json!({"name":"bash"})]).unwrap_err().contains("reserved"));
        assert!(declare_tools(vec![json!({"name":"a"}), json!(3)]).unwrap_err().starts_with("tools[1]"));
        assert!(declare_tools(Vec::new()).unwrap().is_empty());
    }

    #[test]
    fn session_start_defaults_keep_today_s_behaviour() {
        let start: SessionStartParams = serde_json::from_value(json!({"cwd":"/"})).unwrap();
        assert!(start.tools.is_empty() && start.builtins);
        assert_eq!(start.permissions, PermissionOwner::Jan);
        let host: SessionStartParams = serde_json::from_value(json!({"cwd":"/","permissions":"host","builtins":false})).unwrap();
        assert_eq!(host.permissions, PermissionOwner::Host);
        assert!(!host.builtins);
        assert!(serde_json::from_value::<SessionStartParams>(json!({"cwd":"/","permissions":"nobody"})).is_err());
    }

    #[test]
    fn mutation_refusals_carry_their_kind() {
        let busy = turn_active(&json!(1));
        assert_eq!(busy["error"]["code"], -32001);
        assert_eq!(busy["error"]["data"], json!({"retryable":true,"kind":"turn_active"}));
        let bad = invalid_tools(&json!(1), "x");
        assert_eq!(bad["error"]["data"], json!({"kind":"invalid_tools"}));
        // The plain helper is unchanged: -32001 is retryable, others carry no data.
        assert_eq!(error(&json!(1), -32001, "m")["error"]["data"], json!({"retryable":true}));
        assert!(error(&json!(1), -32602, "m")["error"]["data"].is_null());
    }
}
