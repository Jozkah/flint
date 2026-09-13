//! A headless JSON-lines API over stdio, for programs that drive agent runs
//! (AH-182).
//!
//! `jan cli agent run --output-format json` answers one question -- how did this
//! run end -- with one object once it is over. A program that supervises runs
//! needs more: start one, watch it happen, answer its approval prompts, ask
//! what is going on, stop it. `jan cli agent serve` reads one JSON request per
//! line on stdin and writes one JSON message per line on stdout.
//!
//! Requests carry an `id` (a string or a number) that the response echoes:
//!
//! ```text
//! {"id":1,"method":"run","params":{"project":".","task":"...","model":"p/m","safe":false}}
//! {"id":2,"method":"status"}
//! {"id":3,"method":"approve","params":{"run":"r1","request":"perm-7","allow":true}}
//! {"id":4,"method":"cancel","params":{"run":"r1"}}
//! {"id":5,"method":"shutdown"}
//! ```
//!
//! Messages out: `ready` once at start (with the protocol version),
//! `response` for every request (`result`, or `error` as a versioned harness
//! error), `event` for every stream event of a run, and exactly one `result`
//! per run -- the same envelope `--output-format json` prints. A request that
//! cannot be read, names an unknown method or carries unknown fields is refused
//! as `invalid_input`; a run that does not exist is `not_found`.
//!
//! A cancelled run stops at once: its orchestration future is dropped, its MCP
//! servers are disconnected, its scratch directory removed, its pending
//! approvals refused, and its result reports `stop_reason: "cancelled"`. End of
//! input or `shutdown` cancels every run still going and waits for each to
//! report before the process exits, so nothing is left running behind it.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::core::agent::events::StreamEvent;
use crate::core::agent::r#loop::PermissionRegistry;
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;

/// Sent in `ready`, so a client can refuse a server it does not speak.
pub const PROTOCOL: &str = "jan-agent-api/1";

/// What a `run` request asks for.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RunSpec {
    #[serde(default = "default_project")]
    pub project: String,
    pub task: String,
    #[serde(default)]
    pub model: Option<String>,
    /// Ask before writes, shell commands and MCP calls; the questions arrive as
    /// `permission_request` events and are answered with `approve`.
    #[serde(default)]
    pub safe: bool,
}

fn default_project() -> String {
    ".".to_string()
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunRef {
    run: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    run: String,
    request: String,
    allow: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Command {
    Run(RunSpec),
    Status,
    Cancel { run: String },
    Approve { run: String, request: String, allow: bool },
    Shutdown,
}

fn refusal(message: impl Into<String>) -> HarnessError {
    HarnessError::new(ErrorKind::InvalidInput, message).at(Stage::Startup)
}

/// Read one request line. The `id` comes back with a refusal whenever it could
/// be read, so a client can tell which of its requests was refused.
// One refusal per malformed line, never on a hot path: boxing it would buy
// nothing.
#[allow(clippy::result_large_err)]
pub(crate) fn parse_line(line: &str) -> Result<(Value, Command), (Value, HarnessError)> {
    let raw: Value = serde_json::from_str(line)
        .map_err(|e| (Value::Null, refusal(format!("a request must be one JSON object per line: {e}"))))?;
    let Some(obj) = raw.as_object() else {
        return Err((Value::Null, refusal("a request must be a JSON object")));
    };
    let id = obj.get("id").cloned().unwrap_or(Value::Null);
    if !(id.is_string() || id.is_number()) {
        return Err((Value::Null, refusal("a request needs an `id`: a string or a number")));
    }
    if let Some(extra) = obj.keys().find(|k| !matches!(k.as_str(), "id" | "method" | "params")) {
        return Err((id, refusal(format!("unknown request field `{extra}`"))));
    }
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        return Err((id, refusal("a request needs a `method`")));
    };
    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));
    let read = |what: &str, e: serde_json::Error| refusal(format!("`{what}` params: {e}"));
    let command = match method {
        "run" => serde_json::from_value::<RunSpec>(params)
            .map_err(|e| read("run", e))
            .and_then(|spec| {
                if spec.task.trim().is_empty() {
                    Err(refusal("`run` needs a non-empty `task`"))
                } else {
                    Ok(Command::Run(spec))
                }
            }),
        "status" | "shutdown" => {
            if params.as_object().is_some_and(|p| !p.is_empty()) {
                Err(refusal(format!("`{method}` takes no params")))
            } else if method == "status" {
                Ok(Command::Status)
            } else {
                Ok(Command::Shutdown)
            }
        }
        "cancel" => serde_json::from_value::<RunRef>(params)
            .map(|r| Command::Cancel { run: r.run })
            .map_err(|e| read("cancel", e)),
        "approve" => serde_json::from_value::<Approval>(params)
            .map(|a| Command::Approve { run: a.run, request: a.request, allow: a.allow })
            .map_err(|e| read("approve", e)),
        other => Err(refusal(format!(
            "unknown method `{other}`; this server answers run, status, approve, cancel and shutdown"
        ))),
    };
    command.map(|c| (id.clone(), c)).map_err(|e| (id, e))
}

/// One line on stdout.
pub(crate) type Emit = mpsc::UnboundedSender<Value>;

/// The approvals a run is waiting on, filled in by the run once it has one.
pub(crate) type ApprovalSlot = Arc<std::sync::Mutex<Option<PermissionRegistry>>>;

/// Starts runs. The server owns the protocol; this owns what a run is, so the
/// protocol can be tested without a model behind it.
pub(crate) trait Runner: Send + Sync + 'static {
    /// Run to the end, emitting `event` messages through `emit`, and return the
    /// result envelope. Must stop promptly once `cancel` fires, clean up after
    /// itself, and return an envelope whose `stop_reason` is `cancelled`.
    fn run(
        &self,
        run: String,
        spec: RunSpec,
        emit: Emit,
        approvals: ApprovalSlot,
        cancel: oneshot::Receiver<()>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl State {
    fn tag(self) -> &'static str {
        match self {
            State::Running => "running",
            State::Completed => "completed",
            State::Failed => "failed",
            State::Cancelled => "cancelled",
        }
    }

    fn of(result: &Value) -> Self {
        if result["stop_reason"] == "cancelled" {
            State::Cancelled
        } else if result["is_error"] == true {
            State::Failed
        } else {
            State::Completed
        }
    }
}

struct Entry {
    task: String,
    state: State,
    cancel: Option<oneshot::Sender<()>>,
    approvals: ApprovalSlot,
    handle: Option<tokio::task::JoinHandle<()>>,
}

type Runs = Arc<Mutex<BTreeMap<String, Entry>>>;

fn response(id: &Value, result: Value) -> Value {
    json!({ "type": "response", "id": id, "result": result })
}

fn error_response(id: &Value, error: &HarnessError) -> Value {
    json!({ "type": "response", "id": id, "error": error.to_wire() })
}

fn not_found(run: &str) -> HarnessError {
    HarnessError::new(ErrorKind::NotFound, format!("no run `{run}` in this session")).at(Stage::Startup)
}

/// Serve requests from `input` until it ends or `shutdown` is asked for, then
/// cancel what is still running and wait for every run to report.
pub(crate) async fn serve<R, W>(input: R, output: W, runner: Arc<dyn Runner>)
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (emit, mut outbox) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut output = output;
        while let Some(message) = outbox.recv().await {
            let mut line = serde_json::to_string(&message).unwrap_or_default();
            line.push('\n');
            // A client that stopped reading must not stop the runs: their
            // records are on disk either way.
            if output.write_all(line.as_bytes()).await.is_err() {
                continue;
            }
            let _ = output.flush().await;
        }
    });
    let _ = emit.send(json!({ "type": "ready", "protocol": PROTOCOL }));

    let runs: Runs = Arc::new(Mutex::new(BTreeMap::new()));
    let mut next = 0u64;
    let mut lines = input.lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(e) => {
                let _ = emit.send(error_response(&Value::Null, &refusal(format!("stdin is not readable: {e}"))));
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let (id, command) = match parse_line(&line) {
            Ok(parsed) => parsed,
            Err((id, e)) => {
                let _ = emit.send(error_response(&id, &e));
                continue;
            }
        };
        match command {
            Command::Run(spec) => {
                next += 1;
                let run = format!("r{next}");
                let (cancel_tx, cancel_rx) = oneshot::channel();
                let approvals: ApprovalSlot = Arc::new(std::sync::Mutex::new(None));
                let task = spec.task.clone();
                // The entry exists before the run can report, so a run that
                // ends at once still finds itself to mark.
                let mut table = runs.lock().await;
                table.insert(
                    run.clone(),
                    Entry { task, state: State::Running, cancel: Some(cancel_tx), approvals: approvals.clone(), handle: None },
                );
                let _ = emit.send(response(&id, json!({ "run": run })));
                let future = runner.run(run.clone(), spec, emit.clone(), approvals, cancel_rx);
                let (runs_for_task, emit_for_task, run_for_task) = (runs.clone(), emit.clone(), run.clone());
                let handle = tokio::spawn(async move {
                    let result = future.await;
                    if let Some(entry) = runs_for_task.lock().await.get_mut(&run_for_task) {
                        entry.state = State::of(&result);
                        entry.cancel = None;
                    }
                    let _ = emit_for_task.send(json!({ "type": "result", "run": run_for_task, "result": result }));
                });
                if let Some(entry) = table.get_mut(&run) {
                    entry.handle = Some(handle);
                }
            }
            Command::Status => {
                let table = runs.lock().await;
                let list: Vec<Value> = table
                    .iter()
                    .map(|(run, e)| json!({ "run": run, "state": e.state.tag(), "task": e.task }))
                    .collect();
                let _ = emit.send(response(&id, json!({ "runs": list })));
            }
            Command::Cancel { run } => {
                let mut table = runs.lock().await;
                let outcome = match table.get_mut(&run) {
                    None => Err(not_found(&run)),
                    Some(entry) => match entry.cancel.take() {
                        Some(cancel) => {
                            let _ = cancel.send(());
                            Ok(json!({ "run": run, "cancelling": true }))
                        }
                        None => Err(refusal(format!("run `{run}` has already ended ({})", entry.state.tag()))),
                    },
                };
                let _ = emit.send(match outcome {
                    Ok(result) => response(&id, result),
                    Err(e) => error_response(&id, &e),
                });
            }
            Command::Approve { run, request, allow } => {
                let slot = runs.lock().await.get(&run).map(|e| e.approvals.clone());
                let registry = slot.as_ref().and_then(|s| s.lock().ok().and_then(|g| g.clone()));
                let outcome = match (slot, registry) {
                    (None, _) => Err(not_found(&run)),
                    (Some(_), None) => Err(HarnessError::new(
                        ErrorKind::NotFound,
                        format!("run `{run}` is not waiting on approval `{request}`"),
                    )
                    .at(Stage::Approval)),
                    (Some(_), Some(registry)) => match registry.lock().await.remove(&request) {
                        Some(sender) => {
                            let decision = if allow { PermissionDecision::AllowOnce } else { PermissionDecision::Deny };
                            let _ = sender.send(decision);
                            Ok(json!({ "run": run, "request": request, "allowed": allow }))
                        }
                        None => Err(HarnessError::new(
                            ErrorKind::NotFound,
                            format!("run `{run}` is not waiting on approval `{request}`"),
                        )
                        .at(Stage::Approval)),
                    },
                };
                let _ = emit.send(match outcome {
                    Ok(result) => response(&id, result),
                    Err(e) => error_response(&id, &e),
                });
            }
            Command::Shutdown => {
                let _ = emit.send(response(&id, json!({ "shuttingDown": true })));
                break;
            }
        }
    }

    // Nothing outlives the server: cancel every run still going, then wait for
    // each to clean up and report.
    let handles: Vec<tokio::task::JoinHandle<()>> = {
        let mut table = runs.lock().await;
        table
            .values_mut()
            .filter_map(|entry| {
                if let Some(cancel) = entry.cancel.take() {
                    let _ = cancel.send(());
                }
                entry.handle.take()
            })
            .collect()
    };
    for handle in handles {
        let _ = handle.await;
    }
    drop(emit);
    let _ = writer.await;
}

/// The runner behind `jan cli agent serve`: the same preparation, loop and
/// persistence as `jan cli agent run`.
pub(crate) struct AgentRunner;

impl Runner for AgentRunner {
    fn run(
        &self,
        run: String,
        spec: RunSpec,
        emit: Emit,
        approvals: ApprovalSlot,
        cancel: oneshot::Receiver<()>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>> {
        Box::pin(run_agent(run, spec, emit, approvals, cancel))
    }
}

async fn run_agent(
    run: String,
    spec: RunSpec,
    emit: Emit,
    approvals: ApprovalSlot,
    mut cancel: oneshot::Receiver<()>,
) -> Value {
    use super::run_report::RunReport;
    let started = std::time::Instant::now();
    let flags = super::SessionFlags { auto_approve: !spec.safe, ..Default::default() };
    let prepared = super::prepare_agent_run(
        &spec.project,
        &spec.task,
        spec.model.clone(),
        false,
        super::providers::ProviderOverrides::default().with_env(),
        flags,
        None,
    );
    let super::PreparedRun { args, body, permission_requests, mcp_task, persist, .. } = match prepared {
        Ok(prepared) => prepared,
        Err(e) => {
            return serde_json::to_value(RunReport::setup_failure(&e).finish(None, "", started.elapsed().as_millis(), None))
                .unwrap_or_default()
        }
    };
    if let Ok(mut slot) = approvals.lock() {
        *slot = Some(permission_requests.clone());
    }

    // AH-026: the turn in flight is on disk as it happens.
    // Written when the run starts, so a run killed mid-turn leaves a thread
    // that can be listed and resumed, not a checkpoint nothing points at.
    if let Some(thread) = persist.thread_id.as_deref() {
        if let Err(e) = super::cli_save_thread(&persist.agent_dir, Some(thread), &persist.model, &persist.history, None) {
            log::warn!("could not save session before the run: {e}");
        }
    }
    let mut checkpoint = match persist.thread_id.as_deref() {
        Some(thread) => match super::inflight::Writer::begin(
            &super::get_thread_dir(&persist.agent_dir, thread),
            &persist.model,
            persist.history.clone(),
        ) {
            Ok(writer) => Some(writer),
            Err(e) => {
                return serde_json::to_value(
                    RunReport::setup_failure(e.message()).finish(None, &persist.model, started.elapsed().as_millis(), None),
                )
                .unwrap_or_default()
            }
        },
        None => None,
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let forward_run = run.clone();
    let forwarder = tokio::spawn(async move {
        let mut report = RunReport::default();
        let mut conversation: Option<Vec<Value>> = None;
        while let Some(ev) = rx.recv().await {
            report.observe(&ev);
            if let StreamEvent::MessagesUpdated { messages } = &ev {
                conversation = Some(messages.clone());
            }
            if let Some(writer) = checkpoint.as_mut() {
                match &ev {
                    StreamEvent::MessagesUpdated { messages } => writer.conversation(messages),
                    StreamEvent::Token { text } => writer.text(text),
                    _ => {}
                }
            }
            let _ = emit.send(json!({ "type": "event", "run": forward_run, "event": ev }));
        }
        (report, conversation, checkpoint)
    });

    let work = async {
        if let Some(task) = mcp_task {
            if let Ok(outcome) = task.await {
                for failure in &outcome.failed {
                    log::warn!("MCP: {failure}");
                }
            }
        }
        crate::core::agent::r#loop::run_orchestration_streamed(&tx, &body, &args).await
    };
    let outcome = tokio::select! {
        result = work => Some(result),
        _ = &mut cancel => None,
    };
    drop(tx);
    let (mut report, conversation, checkpoint) = match forwarder.await {
        Ok(done) => done,
        Err(_) => (RunReport::default(), None, None),
    };

    // Whatever happened, this run's servers, scratch space and pending
    // approvals end with it.
    let names: Vec<String> = args.mcp_servers.lock().await.keys().cloned().collect();
    for name in names {
        super::mcp::disconnect(&name, &args.mcp_servers).await;
    }
    permission_requests.lock().await.clear();
    if let Some(session) = args.session_id.as_deref() {
        let _ = tauri_plugin_agent_tools::workspace::remove_scratch_dir(session).await;
    }

    let elapsed = started.elapsed().as_millis();
    let model = persist.model.clone();
    match outcome {
        // A cancelled run's partial conversation is not written: `--resume`
        // continues finished turns, not one cut off mid-request.
        // A client's cancel is a decision, not an interruption: nothing is left
        // in flight for a later resume to find.
        None => {
            if let Some(writer) = checkpoint {
                writer.finish();
            }
            report.cancel("the run was cancelled by the client");
            serde_json::to_value(report.finish(None, &model, elapsed, None)).unwrap_or_default()
        }
        Some(result) => {
            let persisted = super::persist_headless_run(persist, &result, conversation);
            if persisted.saved || result.is_ok() {
                if let Some(writer) = checkpoint {
                    writer.finish();
                }
            }
            serde_json::to_value(report.finish(
                persisted.session_id.as_deref().map(super::short_id).as_deref(),
                &model,
                elapsed,
                persisted.final_text.as_deref(),
            ))
            .unwrap_or_default()
        }
    }
}

/// `jan cli agent serve`: the API on this process's stdin and stdout.
pub async fn serve_stdio() {
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    serve(input, tokio::io::stdout(), Arc::new(AgentRunner)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::{BufReader, DuplexStream, Lines};

    /// Counts runs whose future is still alive, so a test can prove a
    /// cancelled or abandoned run left nothing behind.
    struct Alive(Arc<AtomicUsize>);

    impl Alive {
        fn new(live: Arc<AtomicUsize>) -> Self {
            live.fetch_add(1, Ordering::SeqCst);
            Self(live)
        }
    }

    impl Drop for Alive {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn envelope(is_error: bool, stop_reason: &str, result: &str) -> Value {
        json!({ "type": "result", "is_error": is_error, "result": result, "stop_reason": stop_reason })
    }

    /// A runner whose task says what to do: `finish`, `fail`, `ask` (wait for an
    /// approval) or anything else (run until cancelled).
    struct Stub {
        live: Arc<AtomicUsize>,
    }

    impl Runner for Stub {
        fn run(
            &self,
            run: String,
            spec: RunSpec,
            emit: Emit,
            approvals: ApprovalSlot,
            cancel: oneshot::Receiver<()>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>> {
            let live = self.live.clone();
            Box::pin(async move {
                let _alive = Alive::new(live);
                let _ = emit.send(json!({ "type": "event", "run": run, "event": { "type": "token", "text": spec.task } }));
                match spec.task.as_str() {
                    "finish" => envelope(false, "stop", "done"),
                    "fail" => envelope(true, "error", ""),
                    "ask" => {
                        let registry: PermissionRegistry = Arc::new(Mutex::new(HashMap::new()));
                        let (tx, rx) = oneshot::channel();
                        registry.lock().await.insert("perm-1".to_string(), tx);
                        *approvals.lock().unwrap() = Some(registry.clone());
                        let _ = emit.send(json!({
                            "type": "event", "run": run,
                            "event": { "type": "permission_request", "request_id": "perm-1" }
                        }));
                        tokio::select! {
                            decision = rx => envelope(false, "stop", &format!("{:?}", decision.ok())),
                            _ = cancel => envelope(true, "cancelled", ""),
                        }
                    }
                    _ => {
                        let _ = cancel.await;
                        envelope(true, "cancelled", "")
                    }
                }
            })
        }
    }

    struct Client {
        writer: Option<DuplexStream>,
        lines: Lines<BufReader<DuplexStream>>,
        server: tokio::task::JoinHandle<()>,
        live: Arc<AtomicUsize>,
    }

    impl Client {
        fn start() -> Self {
            let live = Arc::new(AtomicUsize::new(0));
            let (writer, server_in) = tokio::io::duplex(64 * 1024);
            let (server_out, reader) = tokio::io::duplex(64 * 1024);
            let server = tokio::spawn(serve(BufReader::new(server_in), server_out, Arc::new(Stub { live: live.clone() })));
            Self { writer: Some(writer), lines: BufReader::new(reader).lines(), server, live }
        }

        async fn send(&mut self, line: &str) {
            let w = self.writer.as_mut().expect("input still open");
            w.write_all(format!("{line}
").as_bytes()).await.unwrap();
        }

        async fn next(&mut self) -> Value {
            let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
                .await
                .expect("a message within five seconds")
                .unwrap()
                .expect("the server is still writing");
            serde_json::from_str(&line).unwrap()
        }

        /// The next message that satisfies `want`, skipping others.
        async fn until(&mut self, want: impl Fn(&Value) -> bool) -> Value {
            loop {
                let message = self.next().await;
                if want(&message) {
                    return message;
                }
            }
        }

        async fn response(&mut self, id: i64) -> Value {
            self.until(|m| m["type"] == "response" && m["id"] == id).await
        }
    }

    fn kind(response: &Value) -> &str {
        response["error"]["kind"].as_str().unwrap_or("")
    }

    #[test]
    fn requests_are_read_strictly_and_refused_by_kind() {
        let ok = |line: &str| parse_line(line).map(|(_, c)| c).unwrap();
        assert_eq!(
            ok(r#"{"id":1,"method":"run","params":{"task":"t"}}"#),
            Command::Run(RunSpec { project: ".".into(), task: "t".into(), model: None, safe: false })
        );
        assert_eq!(ok(r#"{"id":"a","method":"status"}"#), Command::Status);
        assert_eq!(ok(r#"{"id":2,"method":"cancel","params":{"run":"r1"}}"#), Command::Cancel { run: "r1".into() });
        assert_eq!(
            ok(r#"{"id":3,"method":"approve","params":{"run":"r1","request":"p","allow":false}}"#),
            Command::Approve { run: "r1".into(), request: "p".into(), allow: false }
        );
        assert_eq!(ok(r#"{"id":4,"method":"shutdown"}"#), Command::Shutdown);

        for (line, id, needle) in [
            ("not json", Value::Null, "one JSON object"),
            ("[1]", Value::Null, "JSON object"),
            (r#"{"method":"status"}"#, Value::Null, "needs an `id`"),
            (r#"{"id":{},"method":"status"}"#, Value::Null, "needs an `id`"),
            (r#"{"id":1}"#, json!(1), "needs a `method`"),
            (r#"{"id":1,"method":"launch"}"#, json!(1), "unknown method `launch`"),
            (r#"{"id":1,"method":"status","extra":true}"#, json!(1), "unknown request field `extra`"),
            (r#"{"id":1,"method":"status","params":{"all":true}}"#, json!(1), "takes no params"),
            (r#"{"id":1,"method":"run","params":{"task":"  "}}"#, json!(1), "non-empty `task`"),
            (r#"{"id":1,"method":"run","params":{"task":"t","sudo":true}}"#, json!(1), "unknown field"),
            (r#"{"id":1,"method":"approve","params":{"run":"r1","request":"p"}}"#, json!(1), "allow"),
        ] {
            let (got_id, e) = parse_line(line).expect_err(line);
            assert_eq!(got_id, id, "{line}");
            assert_eq!(e.kind(), ErrorKind::InvalidInput, "{line}");
            assert!(e.message().contains(needle), "{line}: {}", e.message());
        }
    }

    #[tokio::test]
    async fn a_run_streams_its_events_and_reports_one_result() {
        let mut c = Client::start();
        let ready = c.next().await;
        assert_eq!(ready, json!({ "type": "ready", "protocol": PROTOCOL }));
        c.send(r#"{"id":1,"method":"run","params":{"task":"finish"}}"#).await;
        assert_eq!(c.response(1).await["result"]["run"], "r1");
        let event = c.until(|m| m["type"] == "event").await;
        assert_eq!(event["run"], "r1");
        assert_eq!(event["event"]["text"], "finish");
        let result = c.until(|m| m["type"] == "result").await;
        assert_eq!(result["run"], "r1");
        assert_eq!(result["result"]["stop_reason"], "stop");
        c.send(r#"{"id":2,"method":"status"}"#).await;
        let status = c.response(2).await;
        assert_eq!(status["result"]["runs"], json!([{ "run": "r1", "state": "completed", "task": "finish" }]));

        c.send(r#"{"id":3,"method":"run","params":{"task":"fail"}}"#).await;
        c.until(|m| m["type"] == "result" && m["run"] == "r2").await;
        c.send(r#"{"id":4,"method":"status"}"#).await;
        assert_eq!(c.response(4).await["result"]["runs"][1]["state"], "failed");

        // A refused request is answered and the server keeps serving.
        c.send("{oops").await;
        let refused = c.until(|m| m["type"] == "response" && m["id"].is_null()).await;
        assert_eq!(kind(&refused), "invalid_input");
        assert_eq!(refused["error"]["v"], 1);
        c.send(r#"{"id":5,"method":"shutdown"}"#).await;
        assert_eq!(c.response(5).await["result"]["shuttingDown"], true);
        tokio::time::timeout(Duration::from_secs(5), c.server).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancel_stops_a_run_and_leaves_nothing_running() {
        let mut c = Client::start();
        c.send(r#"{"id":1,"method":"run","params":{"task":"wait"}}"#).await;
        c.response(1).await;
        c.until(|m| m["type"] == "event").await;
        assert_eq!(c.live.load(Ordering::SeqCst), 1);
        c.send(r#"{"id":2,"method":"status"}"#).await;
        assert_eq!(c.response(2).await["result"]["runs"][0]["state"], "running");

        c.send(r#"{"id":3,"method":"cancel","params":{"run":"r1"}}"#).await;
        assert_eq!(c.response(3).await["result"]["cancelling"], true);
        let result = c.until(|m| m["type"] == "result").await;
        assert_eq!(result["result"]["stop_reason"], "cancelled");
        assert_eq!(c.live.load(Ordering::SeqCst), 0, "the cancelled run's future is gone");
        c.send(r#"{"id":4,"method":"status"}"#).await;
        assert_eq!(c.response(4).await["result"]["runs"][0]["state"], "cancelled");

        c.send(r#"{"id":5,"method":"cancel","params":{"run":"r1"}}"#).await;
        let again = c.response(5).await;
        assert_eq!(kind(&again), "invalid_input");
        assert!(again["error"]["message"].as_str().unwrap().contains("already ended"));
        c.send(r#"{"id":6,"method":"cancel","params":{"run":"r9"}}"#).await;
        assert_eq!(kind(&c.response(6).await), "not_found");
    }

    #[tokio::test]
    async fn an_approval_reaches_the_run_that_asked_and_only_once() {
        let mut c = Client::start();
        c.send(r#"{"id":1,"method":"run","params":{"task":"ask","safe":true}}"#).await;
        c.response(1).await;
        let asked = c.until(|m| m["event"]["type"] == "permission_request").await;
        assert_eq!(asked["run"], "r1");

        c.send(r#"{"id":2,"method":"approve","params":{"run":"r1","request":"perm-2","allow":true}}"#).await;
        let wrong = c.response(2).await;
        assert_eq!(kind(&wrong), "not_found");
        assert_eq!(wrong["error"]["stage"], "approval");
        c.send(r#"{"id":3,"method":"approve","params":{"run":"r7","request":"perm-1","allow":true}}"#).await;
        assert_eq!(kind(&c.response(3).await), "not_found");
        c.send(r#"{"id":4,"method":"approve","params":{"run":"r1","request":"perm-1","allow":true}}"#).await;
        assert_eq!(c.response(4).await["result"]["allowed"], true);
        let result = c.until(|m| m["type"] == "result").await;
        assert_eq!(result["result"]["result"], "Some(AllowOnce)");
        c.send(r#"{"id":5,"method":"approve","params":{"run":"r1","request":"perm-1","allow":true}}"#).await;
        assert_eq!(kind(&c.response(5).await), "not_found", "an approval is answered once");
    }

    #[tokio::test]
    async fn end_of_input_cancels_every_run_and_waits_for_each_to_report() {
        let mut c = Client::start();
        c.send(r#"{"id":1,"method":"run","params":{"task":"wait"}}"#).await;
        c.send(r#"{"id":2,"method":"run","params":{"task":"ask"}}"#).await;
        c.response(2).await;
        c.until(|m| m["event"]["type"] == "permission_request").await;
        assert_eq!(c.live.load(Ordering::SeqCst), 2);
        drop(c.writer.take());
        let mut cancelled = Vec::new();
        while cancelled.len() < 2 {
            let m = c.until(|m| m["type"] == "result").await;
            assert_eq!(m["result"]["stop_reason"], "cancelled");
            cancelled.push(m["run"].as_str().unwrap().to_string());
        }
        cancelled.sort();
        assert_eq!(cancelled, ["r1", "r2"]);
        tokio::time::timeout(Duration::from_secs(5), c.server).await.expect("the server exits").unwrap();
        assert_eq!(c.live.load(Ordering::SeqCst), 0, "nothing outlives the server");
        assert!(c.lines.next_line().await.unwrap().is_none(), "output closes after the last result");
    }
}
