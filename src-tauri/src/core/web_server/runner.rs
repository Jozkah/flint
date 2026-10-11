//! The server-side session runner (phase P1 of docs/MOBILE.md, "Server
//! runner"): `flint serve --agent-run` runs the Rust agent loop on the host for
//! a signed-in client that has no agent of its own.
//!
//! One live session is one actor task. It owns the agent, the history and the
//! one active turn; every HTTP command is a message to it, so "one active turn
//! per session" is a property of the task rather than a lock discipline. The
//! turn steps themselves (body, relay, steering, outcome) are
//! `core::cli::turn_host`, shared with the stdio RPC loop.
//!
//! What a client sees:
//!
//! - commands `agent_run_{create,start,steer,interrupt,approve,answer_ask,
//!   set_model,set_mode,delete}` over `/api/v1/rpc/<command>`;
//! - a live event stream `GET /api/v1/agent/sessions/<id>/events` (replay from
//!   a per-session ring, then the live tail, heartbeats while idle);
//! - coarse pings `agent-session-changed` and `agent-approval-pending` on
//!   `/api/v1/events`.
//!
//! Safety, in the order a request meets it: the sign-in gate and `--agent-run`
//! (server.rs), the folder confined to the operator's roots (`Agent::confine`),
//! the access level (read-only by default; `auto` and `bypass` only with
//! `--agent-allow-bypass`), the command sandbox on every session, approvals
//! that must name a request of that very session and deny after a timeout, and
//! redaction of every payload that leaves.
//!
//! Persistence: the thread (`<data>/threads/<id>`) is written at create and
//! after every turn, with `folder`, `access`, `mode` and `source: "runner"`
//! in its metadata, so a restarted server lists and can resume it. The agent
//! loop's own event log (`<data>/events`) carries the durable record; the ring
//! here carries the token stream, which is not logged.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::{header, Response};
use serde_json::{json, Value};
use tauri_plugin_agent_tools::tools::gate::PermissionDecision;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

use super::agent::Fail;
use super::agent_runs;
use super::events::Bus;
use super::server::Resp;
use crate::core::agent::events::StreamEvent;
use crate::core::cli::providers::ProviderOverrides;
use crate::core::cli::stream_input::{parse_input_line, MAX_LINE_BYTES};
use crate::core::cli::turn_host::{
    begin_turn, parse_decision, release_requests, settle_turn, spawn_turn, Persist, TurnMessage,
    TurnTask,
};
use crate::core::cli::{
    cli_read_messages_lenient, prepare_agent_session, rebuild_wire_history, AgentSession,
    PermissionMode, SessionFlags,
};

/// Events kept per live session for replay; older ones are on disk (the event
/// log) or in the transcript, which a client refetches on a `gap`.
const RING: usize = 4096;
const HEARTBEAT: Duration = Duration::from_secs(15);
/// A live session nobody has touched this long is dropped from memory. Its
/// thread is on disk; the next `agent_run_start` resumes it.
const IDLE_EVICT: Duration = Duration::from_secs(30 * 60);
const TURNS_PER_MINUTE: usize = 20;
const MAX_TITLE: usize = 80;

/// Commands this module answers.
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "agent_run_create"
            | "agent_run_start"
            | "agent_run_steer"
            | "agent_run_interrupt"
            | "agent_run_approve"
            | "agent_run_answer_ask"
            | "agent_run_delete"
            | "agent_run_set_model"
            | "agent_run_set_mode"
    )
}

/// The operator's switches (`--agent-max-sessions`, `--agent-allow-bypass`,
/// `--agent-allow-always`, `--agent-approval-timeout`,
/// `--agent-require-sandbox`).
#[derive(Debug, Clone)]
pub struct RunnerOptions {
    pub max_sessions: u32,
    pub allow_bypass: bool,
    pub allow_always: bool,
    pub approval_timeout: Duration,
    pub require_sandbox: bool,
}

impl Default for RunnerOptions {
    fn default() -> Self {
        RunnerOptions {
            max_sessions: 4,
            allow_bypass: false,
            allow_always: false,
            approval_timeout: Duration::from_secs(30 * 60),
            require_sandbox: true,
        }
    }
}

/// Who is asking, for the audit trail: a short digest of the sign-in token and
/// of the address, never either value.
#[derive(Debug, Clone, Default)]
pub struct Caller {
    pub client: String,
    pub ip_hash: String,
}

impl Caller {
    pub fn digest(token: &str, ip: std::net::IpAddr) -> Caller {
        use sha2::{Digest, Sha256};
        let short = |input: String| {
            let mut h = Sha256::new();
            h.update(input.as_bytes());
            hex::encode(h.finalize())[..12].to_owned()
        };
        Caller { client: short(format!("client:{token}")), ip_hash: short(format!("ip:{ip}")) }
    }
}

fn fail(status: u16, message: impl Into<String>) -> Fail {
    Fail { status, body: Value::String(message.into()) }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Redact every string in a payload that leaves the server.
pub(crate) fn scrub(mut value: Value) -> Value {
    crate::core::cli::secrets::scrub_json(&mut value);
    value
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/// The access level a client asks for, in the words of the Cowork modes.
/// `read` is read-only plan mode.
fn parse_access(raw: Option<&str>, allow_bypass: bool) -> Result<PermissionMode, Fail> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("ask");
    let mode = match raw.to_ascii_lowercase().as_str() {
        "read" | "review" => PermissionMode::Review,
        other => PermissionMode::parse(other).map_err(|m| fail(400, m))?,
    };
    if matches!(mode, PermissionMode::Auto | PermissionMode::Bypass) && !allow_bypass {
        return Err(fail(
            403,
            "this server does not allow unattended access; start it with --agent-allow-bypass",
        ));
    }
    Ok(mode)
}

fn access_name(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Review => "read",
        other => other.as_str(),
    }
}

// ---------------------------------------------------------------------------
// The feed: what a session has said, for replay and tail
// ---------------------------------------------------------------------------

struct Feed {
    seq: u64,
    ring: VecDeque<(u64, Arc<str>)>,
    status: &'static str,
    /// Permission prompts waiting for an answer, as the client reads them.
    pending: Vec<Value>,
    asks: Vec<Value>,
    model: String,
    access: &'static str,
    turns: u32,
    /// The seq a client subscribes after to see the turn in flight from its
    /// first event (what `agent_run_start` returned as `after`).
    turn_after: u64,
}

struct Shared {
    feed: Mutex<Feed>,
    tail: broadcast::Sender<(u64, Arc<str>)>,
}

impl Shared {
    fn new(model: &str, access: &'static str) -> Shared {
        Shared {
            feed: Mutex::new(Feed {
                seq: 0,
                ring: VecDeque::new(),
                status: "idle",
                pending: Vec::new(),
                asks: Vec::new(),
                model: model.to_owned(),
                access,
                turns: 0,
                turn_after: 0,
            }),
            tail: broadcast::channel(512).0,
        }
    }

    /// Number the event, keep it, and tell every tail. The send happens under
    /// the feed lock, so a subscriber that snapshots the ring under the same
    /// lock sees every event exactly once between the two.
    fn publish(&self, kind: &str, payload: Value) -> u64 {
        let mut feed = self.feed.lock().unwrap();
        feed.seq += 1;
        let seq = feed.seq;
        let frame: Arc<str> = json!({
            "seq": seq,
            "source": "live",
            "kind": kind,
            "at": now_ms(),
            "payload": scrub(payload),
        })
        .to_string()
        .into();
        feed.ring.push_back((seq, frame.clone()));
        while feed.ring.len() > RING {
            feed.ring.pop_front();
        }
        let _ = self.tail.send((seq, frame));
        seq
    }

    fn with<R>(&self, f: impl FnOnce(&mut Feed) -> R) -> R {
        f(&mut self.feed.lock().unwrap())
    }
}

fn sse_frame(seq: u64, json: &str) -> String {
    format!("id: {seq}\ndata: {json}\n\n")
}

// ---------------------------------------------------------------------------
// Commands to a session's actor
// ---------------------------------------------------------------------------

type Reply = oneshot::Sender<Result<Value, Fail>>;

enum Cmd {
    Start { input: Value, caller: Caller, reply: Reply },
    Steer { text: String, reply: Reply },
    Interrupt { reply: Reply },
    Approve { request_id: String, decision: PermissionDecision, by: String, ip_hash: String, reply: Option<Reply> },
    AnswerAsk { request_id: String, results: Vec<crate::core::agent::interaction::QuestionResult>, reply: Reply },
    SetModel { model: String, reply: Reply },
    SetAccess { mode: PermissionMode, reply: Reply },
    Delete { reply: Reply },
}

struct Live {
    tx: mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
}

/// The agent's own state for one session.
struct Session {
    agent: AgentSession,
    history: Vec<Value>,
    id: String,
    flags: SessionFlags,
    mode: PermissionMode,
    folder: PathBuf,
    metadata: Value,
    title: String,
    asks: crate::core::agent::interaction::AskRegistry,
    turns: u32,
}

struct Active {
    turn_id: String,
    task: TurnTask,
    updated_history: Option<Vec<Value>>,
    started: Instant,
}

pub struct Runner {
    data_folder: PathBuf,
    roots: Vec<PathBuf>,
    options: RunnerOptions,
    bus: Bus,
    live: Mutex<HashMap<String, Arc<Live>>>,
}

impl Runner {
    pub fn new(data_folder: &Path, roots: &[PathBuf], options: RunnerOptions, bus: Bus) -> Runner {
        Runner {
            data_folder: data_folder.to_path_buf(),
            roots: roots.to_vec(),
            options,
            bus,
            live: Mutex::new(HashMap::new()),
        }
    }

    pub fn options(&self) -> &RunnerOptions {
        &self.options
    }

    fn get(&self, id: &str) -> Option<Arc<Live>> {
        self.live.lock().unwrap().get(id).cloned()
    }

    /// The live state of a session, laid over its stored summary row.
    pub fn overlay(&self, row: &mut Value) {
        let Some(id) = row.get("id").and_then(Value::as_str) else { return };
        let Some(live) = self.get(id) else { return };
        live.shared.with(|feed| {
            row["status"] = json!(feed.status);
            row["live"] = json!(true);
            row["access"] = json!(feed.access);
            row["pendingApprovals"] = json!(feed.pending);
            row["pendingAsks"] = json!(feed.asks);
            row["lastSeq"] = json!(feed.seq);
            row["turnAfter"] = json!(feed.turn_after);
            row["model"] = json!(feed.model);
        });
    }

    /// Live sessions' count, for the probe.
    pub fn live_count(&self) -> usize {
        self.live.lock().unwrap().len()
    }

    // ---- stream -----------------------------------------------------------

    /// The live stream of one session, or `None` when it is not live (the
    /// caller then serves the finite replay of what is on disk).
    pub fn tail(&self, id: &str, after: u64) -> Option<Resp> {
        let live = self.get(id)?;
        let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
        let shared = live.shared.clone();
        let id = id.to_owned();
        // Subscribe and snapshot under one lock; see `Shared::publish`.
        let (mut events, backlog, hello, mut last) = {
            let feed = shared.feed.lock().unwrap();
            let events = shared.tail.subscribe();
            let mut after = after;
            let first = feed.ring.front().map(|(s, _)| *s).unwrap_or(feed.seq + 1);
            let mut preface = String::from(": live\n\n");
            if after > feed.seq {
                // The client's cursor is from an earlier life of this session
                // (the server restarted): start over and say so.
                preface.push_str(&format!("event: reset\ndata: {}\n\n", json!({ "seq": feed.seq })));
                after = 0;
            } else if after + 1 < first {
                preface.push_str(&format!(
                    "event: gap\ndata: {}\n\n",
                    json!({ "from": first, "after": after, "refetch": "agent_run_get" })
                ));
            }
            let hello = format!(
                "event: hello\ndata: {}\n\n",
                json!({ "session": id, "status": feed.status, "seq": feed.seq, "pendingApprovals": feed.pending })
            );
            let backlog: Vec<(u64, Arc<str>)> =
                feed.ring.iter().filter(|(s, _)| *s > after).cloned().collect();
            (events, backlog, preface + &hello, after)
        };
        tokio::spawn(async move {
            if tx.send(Bytes::from(hello)).is_err() {
                return;
            }
            for (seq, json) in backlog {
                last = seq;
                if tx.send(Bytes::from(sse_frame(seq, &json))).is_err() {
                    return;
                }
            }
            let mut tick = tokio::time::interval(HEARTBEAT);
            tick.tick().await;
            loop {
                let chunk = tokio::select! {
                    received = events.recv() => match received {
                        Ok((seq, json)) => {
                            if seq <= last { continue; }
                            last = seq;
                            Bytes::from(sse_frame(seq, &json))
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Fell behind: resend what the ring still holds.
                            let missed: Vec<(u64, Arc<str>)> = shared.with(|feed| {
                                feed.ring.iter().filter(|(s, _)| *s > last).cloned().collect()
                            });
                            let mut buffer = String::new();
                            for (seq, json) in missed {
                                last = seq;
                                buffer.push_str(&sse_frame(seq, &json));
                            }
                            if buffer.is_empty() { continue; }
                            Bytes::from(buffer)
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            let _ = tx.send(Bytes::from_static(b"event: end\ndata: {\"reason\":\"closed\"}\n\n"));
                            break;
                        }
                    },
                    _ = tick.tick() => Bytes::from_static(b": keepalive\n\n"),
                };
                // A client that went away ends the task here, on the next
                // event or heartbeat.
                if tx.send(chunk).is_err() {
                    break;
                }
            }
        });
        let body = StreamBody::new(
            UnboundedReceiverStream::new(rx).map(|bytes| Ok::<_, Infallible>(Frame::data(bytes))),
        );
        let mut response = Response::new(body.boxed_unsync());
        let headers = response.headers_mut();
        headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
        headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        headers.insert("x-accel-buffering", "no".parse().unwrap());
        headers.insert("x-content-type-options", "nosniff".parse().unwrap());
        Some(response)
    }

    // ---- commands ---------------------------------------------------------

    /// Run one command. `confined` is the session's folder for `create`,
    /// already resolved inside the roots by the caller.
    pub async fn call(
        self: &Arc<Self>,
        command: &str,
        args: &Value,
        caller: &Caller,
        confined: Option<PathBuf>,
    ) -> Result<Value, Fail> {
        match command {
            "agent_run_create" => {
                let folder = confined.ok_or_else(|| fail(400, "folder is required"))?;
                self.create(&folder, args, caller).await
            }
            "agent_run_start" => {
                let id = text(args, "id")?;
                let input = args.get("input").cloned().ok_or_else(|| fail(400, "input is required"))?;
                let input = check_input(&input)?;
                let live = self.live_or_resume(id).await?;
                self.send(&live, |reply| Cmd::Start { input, caller: caller.clone(), reply }).await
            }
            "agent_run_steer" => {
                let live = self.require(text(args, "id")?)?;
                let body = text(args, "text")?.to_owned();
                if body.len() > MAX_LINE_BYTES {
                    return Err(fail(413, "message is too large"));
                }
                self.send(&live, |reply| Cmd::Steer { text: body, reply }).await
            }
            "agent_run_interrupt" => {
                let live = self.require(text(args, "id")?)?;
                self.send(&live, |reply| Cmd::Interrupt { reply }).await
            }
            "agent_run_approve" => {
                let live = self.require(text(args, "id")?)?;
                let request_id = text(args, "requestId")?.to_owned();
                let decision = text(args, "decision")?;
                let decision = parse_decision(decision)
                    .ok_or_else(|| fail(400, "decision must be allow_once, allow_always or deny"))?;
                if decision == PermissionDecision::AllowAlways && !self.options.allow_always {
                    return Err(fail(
                        403,
                        "this server does not grant standing approvals; start it with --agent-allow-always",
                    ));
                }
                let (by, ip) = (caller.client.clone(), caller.ip_hash.clone());
                self.send(&live, |reply| Cmd::Approve {
                    request_id,
                    decision,
                    by,
                    ip_hash: ip,
                    reply: Some(reply),
                })
                .await
            }
            "agent_run_answer_ask" => {
                let live = self.require(text(args, "id")?)?;
                let request_id = text(args, "requestId")?.to_owned();
                let mut raw = args.get("results").cloned().unwrap_or(Value::Null);
                if let Some(items) = raw.as_array_mut() {
                    for item in items {
                        if let Some(obj) = item.as_object_mut() {
                            if let Some(custom) = obj.remove("customInput") {
                                obj.entry("custom_input").or_insert(custom);
                            }
                        }
                    }
                }
                let results = serde_json::from_value(raw)
                    .map_err(|e| fail(400, format!("results are not valid: {e}")))?;
                self.send(&live, |reply| Cmd::AnswerAsk { request_id, results, reply }).await
            }
            "agent_run_set_model" => {
                let live = self.require(text(args, "id")?)?;
                let model = text(args, "model")?.trim().to_owned();
                self.send(&live, |reply| Cmd::SetModel { model, reply }).await
            }
            "agent_run_set_mode" => {
                let live = self.require(text(args, "id")?)?;
                let mode = parse_access(args.get("access").and_then(Value::as_str), self.options.allow_bypass)?;
                self.send(&live, |reply| Cmd::SetAccess { mode, reply }).await
            }
            "agent_run_delete" => {
                let id = text(args, "id")?;
                match self.get(id) {
                    Some(live) => self.send(&live, |reply| Cmd::Delete { reply }).await,
                    None => self.delete_stored(id),
                }
            }
            _ => Err(fail(404, "Unknown agent command")),
        }
    }

    fn require(&self, id: &str) -> Result<Arc<Live>, Fail> {
        self.get(id).ok_or_else(|| {
            fail(404, "that session is not running on this server; start it with agent_run_start")
        })
    }

    async fn send(
        &self,
        live: &Live,
        build: impl FnOnce(Reply) -> Cmd,
    ) -> Result<Value, Fail> {
        let (reply, answer) = oneshot::channel();
        live.tx
            .send(build(reply))
            .await
            .map_err(|_| fail(410, "that session has ended"))?;
        answer.await.map_err(|_| fail(410, "that session has ended"))?
    }

    /// A stored session that is not live: it may be deleted if the runner
    /// started it.
    fn delete_stored(&self, id: &str) -> Result<Value, Fail> {
        let (_, thread) = agent_runs::open(&self.data_folder, &self.roots, id)?;
        if thread.pointer("/metadata/source").and_then(Value::as_str) != Some("runner") {
            return Err(fail(403, "only sessions started on this server can be deleted here"));
        }
        crate::core::cli::delete_thread_at(&self.data_folder, id)
            .map_err(|m| fail(500, format!("could not delete the session: {m}")))?;
        self.bus.publish("agent-session-changed", &json!({ "id": id, "status": "deleted" }));
        Ok(json!({ "deleted": true }))
    }

    async fn create(self: &Arc<Self>, folder: &Path, args: &Value, caller: &Caller) -> Result<Value, Fail> {
        if !folder.is_dir() {
            return Err(fail(400, "that is not a folder"));
        }
        let mode = parse_access(args.get("access").and_then(Value::as_str), self.options.allow_bypass)?;
        let kind = args
            .get("mode")
            .and_then(Value::as_str)
            .map(|m| m.chars().filter(|c| !c.is_control()).take(32).collect::<String>())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "cowork".to_owned());
        let model = args
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_owned);
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .map(|t| t.chars().filter(|c| !c.is_control()).take(MAX_TITLE).collect::<String>())
            .unwrap_or_default();
        if self.live_count() >= self.options.max_sessions as usize {
            return Err(fail(
                429,
                format!("this server runs at most {} sessions at once", self.options.max_sessions),
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let metadata = json!({
            "source": "runner",
            "remote": true,
            "folder": folder.to_string_lossy(),
            "access": access_name(mode),
            "mode": kind,
            "client": caller.client,
            "createdFrom": caller.ip_hash,
        });
        let session = self.build_session(folder, model, mode, &id, Vec::new(), metadata, title).await?;
        self.write_stub(&session)?;
        let info = self.admit(session)?;
        self.bus.publish("agent-session-changed", &json!({ "id": id, "status": "idle" }));
        Ok(info)
    }

    /// Build the agent for a session. Bash always runs in the sandbox (the
    /// caller refused earlier when it cannot), no worktree is made, and no MCP
    /// server is connected: a remote session gets the built-in tools only.
    #[allow(clippy::too_many_arguments)]
    async fn build_session(
        &self,
        folder: &Path,
        model: Option<String>,
        mode: PermissionMode,
        id: &str,
        history: Vec<Value>,
        metadata: Value,
        title: String,
    ) -> Result<Session, Fail> {
        let flags = SessionFlags {
            auto_approve: mode.auto_approve(),
            plan: mode.plan(),
            require_model: true,
            sandbox: Some(tauri_plugin_agent_tools::tools::jail::backend().enforces()),
            worktree: Some(false),
            ..Default::default()
        };
        let mut agent = prepare_agent_session(
            &folder.to_string_lossy(),
            model,
            ProviderOverrides::default(),
            flags.clone(),
            None,
        )
        .map_err(|m| fail(422, m))?;
        let asks: crate::core::agent::interaction::AskRegistry =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        configure(&mut agent, id, &asks);
        Ok(Session {
            agent,
            history,
            id: id.to_owned(),
            flags,
            mode,
            folder: folder.to_path_buf(),
            metadata,
            title,
            asks,
            turns: 0,
        })
    }

    /// The thread record a session has before its first turn, so it is listed
    /// and confined like any other.
    fn write_stub(&self, session: &Session) -> Result<(), Fail> {
        use crate::core::threads::{helpers, utils};
        let base = &self.data_folder;
        utils::ensure_data_dirs(base).map_err(|m| fail(500, m))?;
        std::fs::create_dir_all(utils::get_thread_dir(base, &session.id))
            .map_err(|e| fail(500, e.to_string()))?;
        let messages = utils::get_messages_path(base, &session.id);
        if !messages.exists() {
            helpers::write_messages_to_file(&[], &messages).map_err(|m| fail(500, m))?;
        }
        self.write_thread(session)
    }

    fn write_thread(&self, session: &Session) -> Result<(), Fail> {
        use crate::core::threads::{helpers, utils};
        let path = utils::get_thread_metadata_path(&self.data_folder, &session.id);
        let existing: Option<Value> =
            std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let created = existing
            .as_ref()
            .and_then(|e| e.get("created").and_then(Value::as_f64))
            .unwrap_or(now);
        let thread = json!({
            "id": session.id,
            "object": "thread",
            "title": session.title,
            "created": created,
            "updated": now,
            "model": { "id": session.agent.model, "provider": "" },
            "metadata": session.metadata,
        });
        helpers::update_thread_metadata(&self.data_folder, &session.id, &thread).map_err(|m| fail(500, m))
    }

    /// Put a built session live: its feed, its actor.
    fn admit(self: &Arc<Self>, session: Session) -> Result<Value, Fail> {
        let id = session.id.clone();
        let shared = Arc::new(Shared::new(&session.agent.model, access_name(session.mode)));
        let (tx, rx) = mpsc::channel(32);
        let live = Arc::new(Live { tx: tx.clone(), shared: shared.clone() });
        {
            let mut map = self.live.lock().unwrap();
            if map.len() >= self.options.max_sessions as usize && !map.contains_key(&id) {
                return Err(fail(
                    429,
                    format!("this server runs at most {} sessions at once", self.options.max_sessions),
                ));
            }
            map.insert(id.clone(), live);
        }
        let info = json!({
            "id": id,
            "folder": session.folder.to_string_lossy(),
            "model": session.agent.model,
            "access": access_name(session.mode),
            "mode": session.metadata.get("mode"),
            "status": "idle",
            "lastSeq": 0,
        });
        let runner = self.clone();
        tokio::spawn(actor(runner, session, shared, rx, tx));
        Ok(info)
    }

    /// The live session, or the stored one brought back: the history is
    /// rebuilt from its saved messages the way `/resume` does.
    async fn live_or_resume(self: &Arc<Self>, id: &str) -> Result<Arc<Live>, Fail> {
        if let Some(live) = self.get(id) {
            return Ok(live);
        }
        let (_, thread) = agent_runs::open(&self.data_folder, &self.roots, id)?;
        let meta = thread.get("metadata").cloned().unwrap_or(Value::Null);
        if meta.get("source").and_then(Value::as_str) != Some("runner") {
            return Err(fail(403, "only sessions started on this server can be continued here"));
        }
        let folder = meta
            .get("folder")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or_else(|| fail(422, "that session records no folder"))?;
        let folder = folder
            .canonicalize()
            .ok()
            .filter(|p| self.roots.iter().any(|r| p.starts_with(r)))
            .ok_or_else(|| fail(403, "that session's folder is outside the folders this server allows"))?;
        let mode = parse_access(meta.get("access").and_then(Value::as_str), self.options.allow_bypass)?;
        let (messages, _) = cli_read_messages_lenient(&self.data_folder, id).map_err(|m| fail(500, m))?;
        let history = rebuild_wire_history(&messages);
        let model = thread.pointer("/model/id").and_then(Value::as_str).map(str::to_owned);
        let title = thread.get("title").and_then(Value::as_str).unwrap_or_default().to_owned();
        if self.live_count() >= self.options.max_sessions as usize {
            return Err(fail(
                429,
                format!("this server runs at most {} sessions at once", self.options.max_sessions),
            ));
        }
        let session = self.build_session(&folder, model, mode, id, history, meta, title).await?;
        self.admit(session)?;
        self.get(id).ok_or_else(|| fail(410, "that session has ended"))
    }
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str, Fail> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| fail(400, format!("{key} is required")))
}

/// A user message the way the stdio protocol checks one: text or content
/// parts, within the shared caps.
fn check_input(input: &Value) -> Result<Value, Fail> {
    let line = if let Some(text) = input.as_str() {
        if text.trim().is_empty() {
            return Err(fail(400, "input must not be empty"));
        }
        json!({"type":"user","text":text})
    } else if input.is_array() {
        json!({"type":"user","content":input})
    } else {
        return Err(fail(400, "input must be text or content parts"));
    };
    let line = line.to_string();
    if line.len() > MAX_LINE_BYTES {
        return Err(fail(413, "input is too large"));
    }
    parse_input_line(&line).map_err(|m| fail(400, m))?;
    Ok(input.clone())
}

/// What a session's agent needs that `prepare_agent_session` does not give a
/// remote session: its client-facing id, the ask registry, no MCP.
fn configure(agent: &mut AgentSession, id: &str, asks: &crate::core::agent::interaction::AskRegistry) {
    agent.args.session_id = Some(id.to_owned());
    agent.args.ask_requests = Some(asks.clone());
    // Built-in tools only (see `build_session`).
    if let Some(task) = agent.mcp_task.take() {
        task.abort();
    }
}

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

async fn actor(
    runner: Arc<Runner>,
    mut session: Session,
    shared: Arc<Shared>,
    mut commands: mpsc::Receiver<Cmd>,
    self_tx: mpsc::Sender<Cmd>,
) {
    let mut active: Option<Active> = None;
    // request id -> tool name, for the audit record and the ownership check.
    let mut approvals: HashMap<String, String> = HashMap::new();
    let mut ask_requests: HashMap<String, crate::core::agent::interaction::AskRequest> = HashMap::new();
    let mut turn_times: VecDeque<Instant> = VecDeque::new();
    let id = session.id.clone();
    let ping = |status: &str| {
        runner.bus.publish("agent-session-changed", &json!({ "id": id, "status": status }));
    };
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break };
                match command {
                    Cmd::Start { input, caller, reply } => {
                        let now = Instant::now();
                        while turn_times.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
                            turn_times.pop_front();
                        }
                        let answer = if active.is_some() {
                            Err(fail(409, "this session has an active turn; steer it or wait for it to finish"))
                        } else if turn_times.len() >= TURNS_PER_MINUTE {
                            Err(fail(429, "too many turns on this session; wait a minute"))
                        } else {
                            turn_times.push_back(now);
                            if session.title.is_empty() {
                                if let Some(first) = input.as_str() {
                                    session.title = first.chars().filter(|c| !c.is_control()).take(MAX_TITLE).collect();
                                }
                            }
                            session.metadata["lastClient"] = json!(caller.client);
                            let body = begin_turn(&session.agent, &mut session.history, input, true);
                            let task = spawn_turn(session.agent.args.clone(), body);
                            let turn_id = uuid::Uuid::new_v4().to_string();
                            // What a client subscribes after to see this turn
                            // from its first event.
                            let before = shared.with(|f| {
                                f.turn_after = f.seq;
                                f.seq
                            });
                            // The words, so a page that comes back mid-turn can
                            // draw the message the turn is answering.
                            let preview = match &session.history.last().map(|m| &m["content"]) {
                                Some(Value::String(text)) => text.chars().take(8000).collect::<String>(),
                                _ => "[message with attachments]".to_owned(),
                            };
                            shared.publish("turn.started", json!({ "turnId": turn_id, "input": preview }));
                            shared.with(|f| f.status = "running");
                            active = Some(Active { turn_id: turn_id.clone(), task, updated_history: None, started: now });
                            ping("running");
                            Ok(json!({ "turnId": turn_id, "after": before }))
                        };
                        let _ = reply.send(answer);
                    }
                    Cmd::Steer { text, reply } => {
                        let answer = match active.as_ref() {
                            Some(turn) if !text.trim().is_empty() => {
                                turn.task.pending.lock().await.push(json!({"role":"user","content":text}));
                                shared.publish("steer.queued", json!({ "bytes": text.len() }));
                                Ok(json!({}))
                            }
                            Some(_) => Err(fail(400, "text must not be empty")),
                            None => Err(fail(409, "this session has no active turn")),
                        };
                        let _ = reply.send(answer);
                    }
                    Cmd::Interrupt { reply } => {
                        let Some(turn) = active.take() else {
                            let _ = reply.send(Err(fail(409, "this session has no active turn")));
                            continue;
                        };
                        turn.task.runner.abort();
                        turn.task.steerer.abort();
                        session.agent.permission_requests.lock().await.clear();
                        cancel_asks(&session).await;
                        approvals.clear();
                        ask_requests.clear();
                        shared.with(|f| { f.pending.clear(); f.asks.clear(); });
                        for event in release_requests(&session.agent.args, "interrupted").await {
                            publish_stream(&shared, &event, &runner.options);
                        }
                        // Persist what the turn had so far, then read it back
                        // the way a resume does: that repairs a tool call the
                        // abort left without its result.
                        let settled = settle_turn(
                            &mut session.history,
                            turn.updated_history,
                            &Ok(Value::Null),
                            true,
                            Some(Persist {
                                base: &runner.data_folder,
                                session_id: &session.id,
                                model: &session.agent.model,
                                metadata: Some(session.metadata.clone()),
                            }),
                        );
                        if let Ok((messages, _)) = cli_read_messages_lenient(&runner.data_folder, &session.id) {
                            let rebuilt = rebuild_wire_history(&messages);
                            if !rebuilt.is_empty() {
                                session.history = rebuilt;
                            }
                        }
                        session.turns += 1;
                        shared.publish("stream", json!({"type":"done","stop_reason":"cancelled","usage":null}));
                        shared.publish(
                            "turn.completed",
                            json!({ "turnId": turn.turn_id, "stopReason": settled.stop_reason, "error": settled.error }),
                        );
                        shared.with(|f| { f.status = "idle"; f.turns = session.turns; });
                        ping("idle");
                        let _ = reply.send(Ok(json!({})));
                    }
                    Cmd::Approve { request_id, decision, by, ip_hash, reply } => {
                        let answer = match approvals.remove(&request_id) {
                            None => Err(fail(404, "no permission request with that id is pending on this session")),
                            Some(tool) => {
                                let sender = session.agent.permission_requests.lock().await.remove(&request_id);
                                match sender {
                                    None => Err(fail(404, "that permission request was already answered")),
                                    Some(sender) => {
                                        let _ = sender.send(decision);
                                        let word = match decision {
                                            PermissionDecision::AllowOnce => "allow_once",
                                            PermissionDecision::AllowAlways => "allow_always",
                                            _ => "deny",
                                        };
                                        audit(&runner.data_folder, &session.id, &request_id, &tool, word, &by, &ip_hash);
                                        shared.publish(
                                            "approval.resolved",
                                            json!({ "requestId": request_id, "decision": word, "by": by }),
                                        );
                                        let waiting = shared.with(|f| {
                                            f.pending.retain(|p| p["request_id"] != json!(request_id));
                                            f.pending.len()
                                        });
                                        if waiting == 0 && active.is_some() {
                                            shared.with(|f| f.status = "running");
                                            ping("running");
                                        }
                                        Ok(json!({}))
                                    }
                                }
                            }
                        };
                        if let Some(reply) = reply {
                            let _ = reply.send(answer);
                        }
                    }
                    Cmd::AnswerAsk { request_id, results, reply } => {
                        let answer = match ask_requests.get(&request_id) {
                            None => Err(fail(404, "no question with that id is pending on this session")),
                            Some(request) => match request.validate_results(&results) {
                                Err(message) => Err(fail(400, message)),
                                Ok(()) => match session.asks.lock().await.remove(&request_id) {
                                    None => Err(fail(404, "that question was already answered")),
                                    Some(sender) => {
                                        let _ = sender.send(Ok(results));
                                        ask_requests.remove(&request_id);
                                        shared.with(|f| f.asks.retain(|a| a["request_id"] != json!(request_id)));
                                        shared.publish("ask.answered", json!({ "requestId": request_id }));
                                        Ok(json!({}))
                                    }
                                },
                            },
                        };
                        let _ = reply.send(answer);
                    }
                    Cmd::SetModel { model, reply } => {
                        let answer = if active.is_some() {
                            Err(fail(409, "this session has an active turn; retry after it finishes"))
                        } else {
                            let configs = session.agent.args.provider_configs.clone();
                            match crate::core::agent::upstream::resolve_upstream_for_model(&model, configs).await {
                                Err(message) => Err(fail(422, message)),
                                Ok(_) => match prepare_agent_session(
                                    &session.folder.to_string_lossy(),
                                    Some(model),
                                    ProviderOverrides::default(),
                                    session.flags.clone(),
                                    None,
                                ) {
                                    Err(message) => Err(fail(422, message)),
                                    Ok(mut agent) => {
                                        configure(&mut agent, &session.id, &session.asks);
                                        session.agent = agent;
                                        let name = session.agent.model.clone();
                                        shared.with(|f| f.model = name.clone());
                                        let _ = runner.write_thread(&session);
                                        shared.publish("session.model", json!({ "model": name }));
                                        Ok(json!({ "model": name }))
                                    }
                                },
                            }
                        };
                        let _ = reply.send(answer);
                    }
                    Cmd::SetAccess { mode, reply } => {
                        let answer = if active.is_some() {
                            Err(fail(409, "this session has an active turn; retry after it finishes"))
                        } else {
                            session.mode = mode;
                            session.flags.auto_approve = mode.auto_approve();
                            session.flags.plan = mode.plan();
                            session.agent.args.auto_approve = mode.auto_approve();
                            session.agent.args.run_mode = if mode.plan() {
                                crate::core::agent::plan::RunMode::Plan
                            } else {
                                crate::core::agent::plan::RunMode::Normal
                            };
                            session.metadata["access"] = json!(access_name(mode));
                            shared.with(|f| f.access = access_name(mode));
                            let _ = runner.write_thread(&session);
                            shared.publish("session.access", json!({ "access": access_name(mode) }));
                            Ok(json!({ "access": access_name(mode) }))
                        };
                        let _ = reply.send(answer);
                    }
                    Cmd::Delete { reply } => {
                        if let Some(turn) = active.take() {
                            turn.task.runner.abort();
                            turn.task.steerer.abort();
                        }
                        session.agent.permission_requests.lock().await.clear();
                        cancel_asks(&session).await;
                        runner.live.lock().unwrap().remove(&session.id);
                        let outcome = crate::core::cli::delete_thread_at(&runner.data_folder, &session.id)
                            .map(|_| json!({ "deleted": true }))
                            .map_err(|m| fail(500, format!("could not delete the session: {m}")));
                        shared.publish("session.deleted", json!({}));
                        ping("deleted");
                        let _ = reply.send(outcome);
                        return;
                    }
                }
            }
            message = async { active.as_mut().expect("active").task.events.recv().await }, if active.is_some() => {
                let Some(message) = message else {
                    // The run's task is gone without an outcome.
                    let turn = active.take().expect("active");
                    finish(&runner, &mut session, &shared, turn, Err("the run ended without an outcome".to_owned()));
                    approvals.clear();
                    ask_requests.clear();
                    ping("idle");
                    continue;
                };
                match message {
                    TurnMessage::Event(event) => {
                        let turn = active.as_mut().expect("active");
                        match &event {
                            StreamEvent::MessagesUpdated { messages } => {
                                turn.updated_history = Some(messages.clone());
                                // The whole history is not a client event.
                                continue;
                            }
                            StreamEvent::PermissionRequest { request_id, tool_name, .. } => {
                                approvals.insert(request_id.clone(), tool_name.clone());
                                let mut wire = serde_json::to_value(&event).unwrap_or(Value::Null);
                                if !runner.options.allow_always {
                                    wire["offers_always"] = json!(false);
                                }
                                shared.with(|f| {
                                    f.pending.push(scrub(wire));
                                    f.status = "awaiting_approval";
                                });
                                runner.bus.publish(
                                    "agent-approval-pending",
                                    &json!({ "id": session.id, "requestId": request_id, "tool": tool_name }),
                                );
                                ping("awaiting_approval");
                                // Nobody answered: deny, and say who did.
                                let timeout = runner.options.approval_timeout;
                                let (tx, request) = (self_tx.clone(), request_id.clone());
                                tokio::spawn(async move {
                                    tokio::time::sleep(timeout).await;
                                    let _ = tx
                                        .send(Cmd::Approve {
                                            request_id: request,
                                            decision: PermissionDecision::Deny,
                                            by: "timeout".to_owned(),
                                            ip_hash: String::new(),
                                            reply: None,
                                        })
                                        .await;
                                });
                            }
                            StreamEvent::AskRequest { request_id, request, .. } => {
                                ask_requests.insert(request_id.clone(), request.clone());
                                let wire = serde_json::to_value(&event).unwrap_or(Value::Null);
                                shared.with(|f| f.asks.push(scrub(wire)));
                                ping("awaiting_answer");
                            }
                            StreamEvent::AskResolved { request_id } => {
                                ask_requests.remove(request_id);
                                shared.with(|f| f.asks.retain(|a| a["request_id"] != json!(request_id)));
                            }
                            _ => {}
                        }
                        publish_stream(&shared, &event, &runner.options);
                    }
                    TurnMessage::Finished(result) => {
                        let turn = active.take().expect("active");
                        finish(&runner, &mut session, &shared, turn, result);
                        approvals.clear();
                        ask_requests.clear();
                        ping("idle");
                    }
                }
            }
            _ = tokio::time::sleep(IDLE_EVICT), if active.is_none() => {
                break;
            }
        }
    }
    runner.live.lock().unwrap().remove(&id);
    shared.publish("session.closed", json!({}));
}

fn publish_stream(shared: &Shared, event: &StreamEvent, options: &RunnerOptions) {
    let mut wire = serde_json::to_value(event).unwrap_or(Value::Null);
    if !options.allow_always && wire["type"] == "permission_request" {
        wire["offers_always"] = json!(false);
    }
    shared.publish("stream", wire);
}

/// A turn's natural end: history, the saved thread, and the record a client
/// closes the turn on.
fn finish(
    runner: &Runner,
    session: &mut Session,
    shared: &Shared,
    turn: Active,
    result: Result<Value, String>,
) {
    turn.task.steerer.abort();
    let settled = settle_turn(
        &mut session.history,
        turn.updated_history,
        &result,
        false,
        Some(Persist {
            base: &runner.data_folder,
            session_id: &session.id,
            model: &session.agent.model,
            metadata: Some(session.metadata.clone()),
        }),
    );
    // The metadata the thread was last saved with includes the title the
    // first message gave it.
    let _ = runner.write_thread(session);
    session.turns += 1;
    shared.publish(
        "turn.completed",
        json!({
            "turnId": turn.turn_id,
            "stopReason": settled.reported_reason(),
            "error": settled.error,
            "ms": turn.started.elapsed().as_millis() as u64,
        }),
    );
    shared.with(|f| {
        f.status = "idle";
        f.turns = session.turns;
        f.pending.clear();
        f.asks.clear();
    });
}

async fn cancel_asks(session: &Session) {
    let mut asks = session.asks.lock().await;
    for (_, sender) in asks.drain() {
        let _ = sender.send(Err(crate::core::agent::interaction::AskError::Cancelled));
    }
}

/// One approval, in the session's own event log: which request, what was
/// decided, by which client (a digest) from which address (a digest).
fn audit(data: &Path, session: &str, request: &str, tool: &str, decision: &str, by: &str, ip_hash: &str) {
    let _ = tauri_plugin_agent_tools::event_log::append(
        data,
        tauri_plugin_agent_tools::event_log::NewEvent {
            id: format!("approval:{request}"),
            session: session.to_owned(),
            run: String::new(),
            invocation: String::new(),
            kind: "permission.decided".to_owned(),
            payload: json!({
                "requestId": request,
                "tool": tool,
                "decision": decision,
                "by": by,
                "ip": ip_hash,
                "source": "server-runner",
            }),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_defaults_to_ask_and_unattended_needs_the_flag() {
        assert_eq!(parse_access(None, false).unwrap(), PermissionMode::Ask);
        assert_eq!(parse_access(Some("read"), false).unwrap(), PermissionMode::Review);
        assert_eq!(parse_access(Some("auto"), false).unwrap_err().status, 403);
        assert_eq!(parse_access(Some("bypass"), false).unwrap_err().status, 403);
        assert_eq!(parse_access(Some("bypass"), true).unwrap(), PermissionMode::Bypass);
        assert_eq!(parse_access(Some("nope"), true).unwrap_err().status, 400);
        assert_eq!(access_name(PermissionMode::Review), "read");
    }

    #[test]
    fn input_is_checked_like_the_stdio_protocol() {
        assert!(check_input(&json!("hello")).is_ok());
        assert_eq!(check_input(&json!("   ")).unwrap_err().status, 400);
        assert_eq!(check_input(&json!(7)).unwrap_err().status, 400);
        assert!(check_input(&json!([{"type":"text","text":"hi"}])).is_ok());
        assert_eq!(check_input(&json!([{"type":"audio"}])).unwrap_err().status, 400);
    }

    #[test]
    fn feed_numbers_events_keeps_a_bounded_ring_and_redacts() {
        let shared = Shared::new("m", "ask");
        for i in 0..(RING + 10) {
            shared.publish("stream", json!({ "type": "token", "text": i.to_string() }));
        }
        shared.with(|f| {
            assert_eq!(f.seq as usize, RING + 10);
            assert_eq!(f.ring.len(), RING);
            assert_eq!(f.ring.front().unwrap().0, 11);
        });
        let shared = Shared::new("m", "ask");
        shared.publish("stream", json!({ "text": "key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" }));
        let frame = shared.with(|f| f.ring.back().unwrap().1.clone());
        assert!(!frame.contains("sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"), "{frame}");
    }

    #[tokio::test]
    async fn a_subscriber_sees_each_event_once_across_snapshot_and_tail() {
        let shared = Shared::new("m", "ask");
        shared.publish("a", json!({}));
        let (mut rx, snapshot) = {
            let feed = shared.feed.lock().unwrap();
            (shared.tail.subscribe(), feed.ring.iter().map(|(s, _)| *s).collect::<Vec<_>>())
        };
        shared.publish("b", json!({}));
        assert_eq!(snapshot, vec![1]);
        assert_eq!(rx.recv().await.unwrap().0, 2);
    }

    #[test]
    fn caller_digests_hide_the_token_and_address() {
        let c = Caller::digest("secret-token", "10.0.0.2".parse().unwrap());
        assert_eq!(c.client.len(), 12);
        assert!(!c.client.contains("secret"));
        assert_ne!(c.client, c.ip_hash);
    }

    #[test]
    fn only_runner_commands_are_handled() {
        for c in ["agent_run_create", "agent_run_start", "agent_run_approve", "agent_run_delete"] {
            assert!(handles(c));
        }
        // The read views stay with agent.rs; nothing that spawns is here.
        assert!(!handles("agent_run_list"));
        assert!(!handles("agent_campaign_cancel"));
    }
}
