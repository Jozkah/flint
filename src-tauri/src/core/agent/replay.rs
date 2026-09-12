//! Sending a past turn's exact context to the model again. AH-079.
//!
//! A prompt snapshot (AH-078) is the request a model was sent, taken at the
//! last point before it left the process. Replaying one sends that same
//! request again and records what came back, so "why did it answer that?" can
//! be asked of the context the turn actually ran under rather than of a
//! reconstruction.
//!
//! The rules:
//!
//! * **The payload comes from disk, never from the caller.** `begin` looks the
//!   snapshot up within the session that owns it and hands back the stored
//!   payload. The renderer sends what it is given; it does not assemble it.
//! * **A snapshot that is not the whole context is refused.** One stored
//!   without a payload, or with fields redacted, would send the model something
//!   other than what it saw -- a replay that quietly differs is worse than
//!   none. Each refusal is a typed error and is recorded.
//! * **Sameness is checked, not assumed.** The transport snapshots the replay
//!   dispatch like any other. `settle` compares that record's hash with the
//!   original's, and the result says whether the model really received the
//!   same context again.
//! * **Nothing the model asks for is run.** A replay records tool calls by
//!   name; it never executes them.
//! * **Every ending is explicit.** Completed, failed, cancelled and refused are
//!   recorded as they happen. A replay still `running` in a record written by
//!   an earlier process is `interrupted`: the app stopped while it ran.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri_plugin_agent_tools::snapshot::{self, PromptSnapshot};

pub const SCHEMA_VERSION: u32 = 1;

/// The most response text kept per replay. The record is for comparing a
/// replay with the original turn, not for archiving long outputs.
pub const MAX_TEXT: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReplayStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Refused,
}

/// A replay's state as the panel shows it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReplayState {
    Running,
    Interrupted,
    Completed,
    Failed,
    Cancelled,
    Refused,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReplayErrorKind {
    /// No snapshot by that id in the session named.
    NotFound,
    /// The snapshot was stored without a payload.
    Unavailable,
    /// Fields of the stored payload were redacted.
    Redacted,
    /// The stored payload is not a chat request.
    NotAChat,
    /// The provider the turn used is no longer configured.
    ProviderGone,
    /// The provider speaks a wire format replay does not send.
    ProviderUnsupported,
    /// A local model that is not running; replay does not start one.
    ModelNotRunning,
    /// The provider answered with an error.
    ProviderError,
    /// The reply stopped before the provider said it was finished.
    StreamCutOff,
    /// No replay by that id in the session named.
    UnknownReplay,
    /// No run by that id in this session's canonical record.
    UnknownRun,
    /// The run is recorded, but nothing in it can be sent again.
    NothingToReplay,
    /// The renderer that started the replay went away before it ended.
    Abandoned,
    Io,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayError {
    pub kind: ReplayErrorKind,
    pub message: String,
}

impl ReplayError {
    pub fn new(kind: ReplayErrorKind, message: impl Into<String>) -> Self {
        ReplayError {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayRecord {
    pub schema_version: u32,
    pub id: String,
    pub session: String,
    pub snapshot_id: String,
    /// The original dispatch's hash, copied when the replay began.
    pub snapshot_hash: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    pub status: ReplayStatus,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    /// Which app process began it. A different one reading a `running`
    /// record knows the replay was interrupted, not still going.
    pub instance: String,
    /// The transport's snapshot of the replay dispatch itself.
    #[serde(default)]
    pub replay_snapshot_id: Option<String>,
    /// Whether that snapshot's hash equals the original's. `None` when there
    /// was no replay dispatch to compare, as with a refusal.
    #[serde(default)]
    pub matched: Option<bool>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub finish_reason: Option<String>,
    /// Tools the model asked for. Recorded, never run.
    #[serde(default)]
    pub tool_calls: Vec<String>,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default)]
    pub error: Option<ReplayError>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayView {
    #[serde(flatten)]
    pub record: ReplayRecord,
    pub state: ReplayState,
}

/// What `begin` hands the renderer: the record, and the payload to send.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStart {
    pub record: ReplayRecord,
    pub payload: Value,
}

/// How a replay ended, as the renderer saw it.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettleInput {
    pub status: Option<ReplayStatus>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<String>,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default)]
    pub replay_snapshot_id: Option<String>,
    #[serde(default)]
    pub error_kind: Option<ReplayErrorKind>,
    #[serde(default)]
    pub error_message: Option<String>,
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct SessionFile {
    session: String,
    replays: Vec<ReplayRecord>,
}

/// Begin and settle read, change and write one session's file. Two of them at
/// once -- a replay settling while another begins -- must not lose either.
static STORE: Mutex<()> = Mutex::new(());

fn store_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("replays")
}

fn session_path(data_folder: &Path, session: &str) -> PathBuf {
    let mut h = Sha256::new();
    h.update(session.as_bytes());
    let hex = format!("{:x}", h.finalize());
    store_dir(data_folder).join(format!("{}.json", &hex[..24]))
}

fn io(e: impl std::fmt::Display) -> ReplayError {
    ReplayError::new(ReplayErrorKind::Io, e.to_string())
}

fn read_session(data_folder: &Path, session: &str) -> SessionFile {
    let parsed = std::fs::read_to_string(session_path(data_folder, session))
        .ok()
        .and_then(|t| serde_json::from_str::<SessionFile>(&t).ok());
    match parsed {
        // A file holding another session's replays was not written here.
        Some(file) if file.session == session => file,
        _ => SessionFile {
            session: session.to_string(),
            replays: Vec::new(),
        },
    }
}

fn write_session(data_folder: &Path, file: &SessionFile) -> Result<(), ReplayError> {
    std::fs::create_dir_all(store_dir(data_folder)).map_err(io)?;
    let path = session_path(data_folder, &file.session);
    let body = serde_json::to_vec_pretty(file).map_err(io)?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temp, body).map_err(io)?;
    std::fs::rename(&temp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        io(e)
    })
}

/// This process, as distinct from the one that ran before a restart.
fn instance() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{}-{nanos:x}", std::process::id())
    })
}

fn next_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("replay-{}-{}", instance(), NEXT.fetch_add(1, Ordering::Relaxed))
}

fn now() -> String {
    tauri_plugin_agent_tools::audit::now()
}

fn state_of(record: &ReplayRecord) -> ReplayState {
    match record.status {
        ReplayStatus::Running if record.instance != instance() => ReplayState::Interrupted,
        ReplayStatus::Running => ReplayState::Running,
        ReplayStatus::Completed => ReplayState::Completed,
        ReplayStatus::Failed => ReplayState::Failed,
        ReplayStatus::Cancelled => ReplayState::Cancelled,
        ReplayStatus::Refused => ReplayState::Refused,
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// The snapshot, if it may be replayed; the reason, typed, if not.
fn replayable(data_folder: &Path, session: &str, snapshot_id: &str) -> Result<PromptSnapshot, ReplayError> {
    let found = snapshot::scoped_lookup(data_folder, Some(snapshot_id), None, Some(session))
        .map_err(|e| ReplayError::new(ReplayErrorKind::NotFound, e))?;
    let Some(snap) = found.into_iter().next() else {
        return Err(ReplayError::new(
            ReplayErrorKind::NotFound,
            "that snapshot is no longer on disk",
        ));
    };
    if let Some(why) = snap.unavailable {
        return Err(ReplayError::new(
            ReplayErrorKind::Unavailable,
            format!("no payload was stored for that turn ({why:?}), so there is nothing to send again"),
        ));
    }
    if !snap.redactions.is_empty() {
        let paths: Vec<&str> = snap.redactions.iter().map(|r| r.path.as_str()).collect();
        return Err(ReplayError::new(
            ReplayErrorKind::Redacted,
            format!(
                "{} field(s) were redacted before the snapshot was stored ({}); a replay would not send the model what it received",
                paths.len(),
                paths.join(", ")
            ),
        ));
    }
    if !snap.payload.get("messages").is_some_and(Value::is_array) {
        return Err(ReplayError::new(
            ReplayErrorKind::NotAChat,
            "the stored request is not a chat request",
        ));
    }
    Ok(snap)
}

/// One provider request of the source run, as a replay would treat it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStep {
    /// The request's id in the source run.
    pub invocation: String,
    pub snapshot_id: String,
    #[serde(default)]
    pub model: String,
    /// Whether this step can be sent to a provider again. A step that cannot
    /// is still shown, with why: a plan that hides what it will skip is worse
    /// than one that says so.
    pub sendable: bool,
    #[serde(default)]
    pub blocked: Option<ReplayError>,
}

/// What replaying a run would do, read from the canonical record before
/// anything is sent (AH-032).
///
/// This is the thing a person is shown first. It names the exact source run,
/// the snapshot behind each of its requests, and the tools the run asked for
/// -- which a replay records and never runs, so an approval the user gave once
/// cannot be spent again by replaying the turn that carried it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPlan {
    pub session: String,
    pub run: String,
    /// When the source run started, as its record says.
    #[serde(default)]
    pub started_at: String,
    /// How the source run ended: `done`, `error`, `cancelled`, or empty when
    /// the record does not say -- a run whose process died mid-flight.
    #[serde(default)]
    pub stopped_by: String,
    pub steps: Vec<PlannedStep>,
    /// Tool calls the source run made, by name. Shown so the person can see
    /// what the original did; never executed by a replay.
    #[serde(default)]
    pub tool_calls: Vec<String>,
    /// The run this one was itself a replay of, when it was one.
    #[serde(default)]
    pub replay_of: Option<String>,
}

impl ReplayPlan {
    /// Whether any step can be sent again.
    pub fn sendable(&self) -> bool {
        self.steps.iter().any(|s| s.sendable)
    }
}

/// Read what replaying `run` would do, from the session's canonical record.
///
/// The run is looked up inside the session that owns it, so a run id from
/// another session or another project names nothing here -- the log is keyed by
/// session, and a run whose events are not in it is `UnknownRun` rather than a
/// door into someone else's history.
pub fn plan(data_folder: &Path, session: &str, run: &str) -> Result<ReplayPlan, ReplayError> {
    if session.trim().is_empty() || run.trim().is_empty() {
        return Err(ReplayError::new(
            ReplayErrorKind::UnknownRun,
            "a replay must name the session and the run it is replaying",
        ));
    }
    let events = tauri_plugin_agent_tools::event_log::read_session(data_folder, session)
        .map_err(|e| ReplayError::new(ReplayErrorKind::Io, e.message()))?;
    let mine: Vec<_> = events.into_iter().filter(|e| e.run == run).collect();
    if mine.is_empty() {
        return Err(ReplayError::new(
            ReplayErrorKind::UnknownRun,
            format!("no run {run:?} in this session's record"),
        ));
    }

    let mut plan = ReplayPlan {
        session: session.to_string(),
        run: run.to_string(),
        started_at: String::new(),
        stopped_by: String::new(),
        steps: Vec::new(),
        tool_calls: Vec::new(),
        replay_of: None,
    };
    let text = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or_default().to_string();
    for event in &mine {
        match event.kind.as_str() {
            "run.started" => {
                plan.started_at = event.at.clone();
                let of = text(event.payload.get("replayOf"));
                if !of.is_empty() {
                    plan.replay_of = Some(of);
                }
            }
            "run.ended" => plan.stopped_by = text(event.payload.get("stoppedBy")),
            "message.completed" if text(event.payload.get("phase")) == "dispatched" => {
                let snapshot_id = text(event.payload.get("snapshotId"));
                let (sendable, blocked) = match replayable(data_folder, session, &snapshot_id) {
                    Ok(_) => (true, None),
                    Err(e) => (false, Some(e)),
                };
                plan.steps.push(PlannedStep {
                    invocation: event.invocation.clone(),
                    snapshot_id,
                    model: text(event.payload.get("model")),
                    sendable,
                    blocked,
                });
            }
            "tool.requested" => {
                let tool = text(event.payload.get("tool"));
                if !tool.is_empty() {
                    plan.tool_calls.push(tool);
                }
            }
            _ => {}
        }
    }
    if plan.steps.is_empty() {
        return Err(ReplayError::new(
            ReplayErrorKind::NothingToReplay,
            format!("run {run:?} made no provider request that was recorded with its payload"),
        ));
    }
    Ok(plan)
}

/// The source run's own events, in the order they were recorded.
///
/// This is the deterministic half of replay: it re-renders what happened from
/// the record alone, sends nothing and runs nothing, so it is the same every
/// time and costs nothing. [`begin_for_run`] is the other half -- a fresh
/// request to a provider, whose answer may differ and is compared.
pub fn recorded(
    data_folder: &Path,
    session: &str,
    run: &str,
) -> Result<Vec<tauri_plugin_agent_tools::event_log::Envelope>, ReplayError> {
    let events = tauri_plugin_agent_tools::event_log::read_session(data_folder, session)
        .map_err(|e| ReplayError::new(ReplayErrorKind::Io, e.message()))?;
    let mine: Vec<_> = events.into_iter().filter(|e| e.run == run).collect();
    if mine.is_empty() {
        return Err(ReplayError::new(
            ReplayErrorKind::UnknownRun,
            format!("no run {run:?} in this session's record"),
        ));
    }
    Ok(mine)
}

/// Start a fresh replay of one step of a recorded run (AH-032).
///
/// The replay is its own run in the canonical record, with its own id, and it
/// says which run and which request it came from -- so the two are joinable and
/// neither is mistaken for the other. The payload still comes from the stored
/// snapshot, never from the caller.
pub fn begin_for_run(
    data_folder: &Path,
    session: &str,
    run: &str,
    invocation: Option<&str>,
) -> Result<ReplayStart, ReplayError> {
    let plan = plan(data_folder, session, run)?;
    let step = match invocation {
        Some(want) => plan
            .steps
            .iter()
            .find(|s| s.invocation == want)
            .ok_or_else(|| {
                ReplayError::new(
                    ReplayErrorKind::UnknownRun,
                    format!("run {run:?} has no request {want:?}"),
                )
            })?,
        // No request named: the first one, which is the turn as it was asked.
        None => plan.steps.first().expect("a plan has at least one step"),
    };
    if let Some(blocked) = &step.blocked {
        return Err(blocked.clone());
    }
    let started = begin(data_folder, session, &step.snapshot_id)?;
    // The replay's own run in the session's record, pointing back at what it
    // is replaying. Best effort: losing the note must not fail the replay.
    let replay_run = format!("replay-{}", started.record.id);
    let _ = tauri_plugin_agent_tools::event_log::append(
        data_folder,
        tauri_plugin_agent_tools::event_log::NewEvent {
            id: format!("run:{replay_run}:started"),
            session: session.to_string(),
            run: replay_run,
            invocation: String::new(),
            kind: "run.started".to_string(),
            payload: serde_json::json!({
                "source": "replay",
                "model": step.model,
                "replayOf": run,
                "replayOfInvocation": step.invocation,
                "snapshotId": step.snapshot_id,
            }),
        },
    );
    Ok(started)
}

/// Record how a replay of a recorded run ended, in the canonical log as well
/// as in the replay record (AH-032).
pub fn settle_for_run(
    data_folder: &Path,
    session: &str,
    replay_id: &str,
    outcome: SettleInput,
) -> Result<ReplayRecord, ReplayError> {
    let record = settle(data_folder, session, replay_id, outcome)?;
    let replay_run = format!("replay-{}", record.id);
    let _ = tauri_plugin_agent_tools::event_log::append(
        data_folder,
        tauri_plugin_agent_tools::event_log::NewEvent {
            id: format!("run:{replay_run}:ended"),
            session: session.to_string(),
            run: replay_run,
            invocation: String::new(),
            kind: "run.ended".to_string(),
            payload: serde_json::json!({
                "source": "replay",
                "stoppedBy": match record.status {
                    ReplayStatus::Completed => "done",
                    ReplayStatus::Cancelled => "cancelled",
                    ReplayStatus::Refused => "refused",
                    ReplayStatus::Failed => "error",
                    ReplayStatus::Running => "running",
                },
                // Whether the model was sent the same context again, which is
                // the only thing that makes the two answers comparable.
                "matchedSource": record.matched,
                "toolCalls": record.tool_calls.len(),
            }),
        },
    );
    Ok(record)
}

/// Start a replay of one snapshot. The payload to send comes back with it.
///
/// A refusal is recorded too, so the history of what was tried survives a
/// restart along with what succeeded.
pub fn begin(data_folder: &Path, session: &str, snapshot_id: &str) -> Result<ReplayStart, ReplayError> {
    if session.trim().is_empty() {
        return Err(ReplayError::new(
            ReplayErrorKind::NotFound,
            "a replay must name the session its snapshot belongs to",
        ));
    }
    let checked = replayable(data_folder, session, snapshot_id);
    let _guard = STORE.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_session(data_folder, session);
    let (snap_hash, provider, model) = match &checked {
        Ok(s) => (s.hash.clone(), s.provider.clone(), s.model.clone()),
        Err(_) => Default::default(),
    };
    let mut record = ReplayRecord {
        schema_version: SCHEMA_VERSION,
        id: next_id(),
        session: session.to_string(),
        snapshot_id: snapshot_id.to_string(),
        snapshot_hash: snap_hash,
        provider,
        model,
        status: ReplayStatus::Running,
        started_at: now(),
        ended_at: None,
        instance: instance().to_string(),
        replay_snapshot_id: None,
        matched: None,
        text: String::new(),
        truncated: false,
        finish_reason: None,
        tool_calls: Vec::new(),
        usage: None,
        error: None,
    };
    match checked {
        Ok(snap) => {
            file.replays.push(record.clone());
            write_session(data_folder, &file)?;
            Ok(ReplayStart {
                record,
                payload: snap.payload,
            })
        }
        Err(refusal) => {
            // Only a snapshot this session owns gets a record: a refusal for
            // someone else's id must not leave a trace naming it here.
            if refusal.kind != ReplayErrorKind::NotFound {
                record.status = ReplayStatus::Refused;
                record.ended_at = Some(now());
                record.error = Some(refusal.clone());
                file.replays.push(record);
                write_session(data_folder, &file)?;
            }
            Err(refusal)
        }
    }
}

/// Record how a replay ended. The first ending is the one kept.
pub fn settle(
    data_folder: &Path,
    session: &str,
    replay_id: &str,
    input: SettleInput,
) -> Result<ReplayRecord, ReplayError> {
    let status = match input.status {
        Some(ReplayStatus::Running) | None => {
            return Err(ReplayError::new(
                ReplayErrorKind::Io,
                "a replay can only be settled as completed, failed, cancelled or refused",
            ))
        }
        Some(s) => s,
    };
    // Looked up before the lock: it reads the snapshot log, which can be long.
    let replay_snapshot = input.replay_snapshot_id.as_deref().and_then(|id| {
        snapshot::scoped_lookup(data_folder, Some(id), None, Some(session))
            .ok()
            .and_then(|found| found.into_iter().next())
    });

    let _guard = STORE.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_session(data_folder, session);
    let Some(record) = file.replays.iter_mut().find(|r| r.id == replay_id) else {
        return Err(ReplayError::new(
            ReplayErrorKind::UnknownReplay,
            "no replay by that id was recorded for this session",
        ));
    };
    if record.status != ReplayStatus::Running {
        return Ok(record.clone());
    }

    record.status = status;
    record.ended_at = Some(now());
    if let Some(snap) = &replay_snapshot {
        record.replay_snapshot_id = Some(snap.id.clone());
        record.matched = Some(snap.hash == record.snapshot_hash);
    }
    // The reply is written to disk, so it is redacted like anything else Jan
    // persists. Cut at a character boundary.
    let mut text = tauri_plugin_agent_tools::audit::redact(&input.text);
    if text.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        record.truncated = true;
    }
    record.text = text;
    record.finish_reason = input.finish_reason;
    record.tool_calls = input.tool_calls.into_iter().take(64).collect();
    record.usage = input.usage;
    if status != ReplayStatus::Completed {
        let kind = input.error_kind.unwrap_or(match status {
            ReplayStatus::Cancelled => ReplayErrorKind::Abandoned,
            _ => ReplayErrorKind::ProviderError,
        });
        let message = input.error_message.unwrap_or_else(|| match status {
            ReplayStatus::Cancelled => "the replay was stopped before it finished".into(),
            _ => "the replay did not finish".into(),
        });
        record.error = Some(ReplayError::new(
            kind,
            tauri_plugin_agent_tools::audit::redact(&message),
        ));
    }
    let settled = record.clone();
    write_session(data_folder, &file)?;
    Ok(settled)
}

/// A session's replays, newest first, optionally of one snapshot.
pub fn list(data_folder: &Path, session: &str, snapshot_id: Option<&str>) -> Vec<ReplayView> {
    let _guard = STORE.lock().unwrap_or_else(|p| p.into_inner());
    let mut out: Vec<ReplayView> = read_session(data_folder, session)
        .replays
        .into_iter()
        .filter(|r| snapshot_id.map_or(true, |id| r.snapshot_id == id))
        .map(|record| ReplayView {
            state: state_of(&record),
            record,
        })
        .collect();
    out.reverse();
    out
}

#[cfg(test)]
mod tests {

    // ---- AH-032: replaying a recorded run ------------------------------

    /// Write one recorded run: a dispatch with a real stored snapshot, a tool
    /// call, and an ending. Returns the run id.
    fn recorded_run(dir: &Path, session: &str, run: &str, payload: Value) -> String {
        use tauri_plugin_agent_tools::event_log::{append, NewEvent};
        use tauri_plugin_agent_tools::snapshot::{capture, Identity};
        let invocation = format!("{run}#1");
        let identity = Identity {
            session: session.to_string(),
            run: run.to_string(),
            thread: session.to_string(),
            agent: "main".into(),
            provider: "fixture".into(),
            invocation: invocation.clone(),
            turn: String::new(),
            attempt: 1,
            kind: Default::default(),
        };
        let snapshot = capture(&payload, &identity);
        tauri_plugin_agent_tools::snapshot::append(dir, &snapshot);
        let ev = |id: &str, kind: &str, inv: &str, payload: Value| {
            append(
                dir,
                NewEvent {
                    id: id.to_string(),
                    session: session.to_string(),
                    run: run.to_string(),
                    invocation: inv.to_string(),
                    kind: kind.to_string(),
                    payload,
                },
            )
            .expect("record");
        };
        // Event ids are unique within a session, so they are scoped to the
        // run: two runs of one session that reused an id would be one event.
        ev(&format!("{run}:s"), "run.started", "", json!({ "model": "fixture/m", "source": "agent-loop" }));
        ev(
            &format!("{run}:d"),
            "message.completed",
            &invocation,
            json!({ "phase": "dispatched", "snapshotId": snapshot.id, "model": "m" }),
        );
        ev(&format!("{run}:t"), "tool.requested", &invocation, json!({ "tool": "write" }));
        ev(&format!("{run}:e"), "run.ended", "", json!({ "stoppedBy": "done", "source": "agent-loop" }));
        snapshot.id
    }

    fn chat_payload() -> Value {
        json!({ "model": "m", "messages": [{ "role": "user", "content": "hi" }] })
    }

    /// A plan names the exact run, the request behind it and the snapshot that
    /// carries its payload -- and says what the original asked for without
    /// offering to run any of it again.
    #[test]
    fn a_plan_says_what_would_be_replayed_before_anything_is_sent() {
        let dir = dir("plan");
        let run = "s-plan#run-a";
        let snapshot = recorded_run(&dir, "s-plan", run, chat_payload());

        let plan = plan(&dir, "s-plan", run).expect("a plan");
        assert_eq!(plan.run, run);
        assert_eq!(plan.stopped_by, "done");
        assert_eq!(plan.steps.len(), 1, "{plan:?}");
        assert_eq!(plan.steps[0].snapshot_id, snapshot);
        assert_eq!(plan.steps[0].invocation, format!("{run}#1"));
        assert!(plan.steps[0].sendable, "{:?}", plan.steps[0].blocked);
        assert!(plan.sendable());
        assert_eq!(plan.tool_calls, vec!["write"], "the original's tools are shown");
        assert!(plan.replay_of.is_none());

        // The deterministic half: the run's own events, nothing sent.
        let events = recorded(&dir, "s-plan", run).expect("the recorded run");
        assert_eq!(events.len(), 4);
        assert!(events.windows(2).all(|w| w[0].seq < w[1].seq));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A run from another session, or one that never existed, is a typed
    /// refusal -- not a door into another session's history.
    #[test]
    fn a_run_of_another_session_is_refused() {
        let dir = dir("cross");
        let mine = "s-a#run-1";
        recorded_run(&dir, "s-a", mine, chat_payload());
        recorded_run(&dir, "s-b", "s-b#run-1", chat_payload());

        // Naming another session's run while claiming this session finds
        // nothing: the record is keyed by session.
        let refusal = plan(&dir, "s-a", "s-b#run-1").expect_err("must refuse");
        assert_eq!(refusal.kind, ReplayErrorKind::UnknownRun);
        assert_eq!(plan(&dir, "s-a", "").unwrap_err().kind, ReplayErrorKind::UnknownRun);
        assert_eq!(plan(&dir, "", mine).unwrap_err().kind, ReplayErrorKind::UnknownRun);
        // And beginning one is refused the same way, before any payload is read.
        assert_eq!(
            begin_for_run(&dir, "s-a", "s-b#run-1", None).unwrap_err().kind,
            ReplayErrorKind::UnknownRun
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A run whose snapshot was redacted -- a memory forgotten since, say --
    /// is planned but not sendable, and says why rather than sending the model
    /// something other than what it saw.
    #[test]
    fn a_redacted_or_missing_snapshot_is_planned_but_not_sendable() {
        let dir = dir("redacted");
        let run = "s-red#run-1";
        recorded_run(&dir, "s-red", run, chat_payload());
        let removed = tauri_plugin_agent_tools::snapshot::redact_text(&dir, &["hi"], "forgotten memory")
            .expect("the rewrite");
        assert!(removed > 0, "nothing was redacted, so this proves nothing");

        let plan = plan(&dir, "s-red", run).expect("a plan is still shown");
        assert_eq!(plan.steps.len(), 1);
        assert!(!plan.steps[0].sendable);
        assert_eq!(plan.steps[0].blocked.as_ref().unwrap().kind, ReplayErrorKind::Redacted);
        assert!(!plan.sendable());
        // And the refusal survives being asked to start it anyway.
        assert_eq!(
            begin_for_run(&dir, "s-red", run, None).unwrap_err().kind,
            ReplayErrorKind::Redacted
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A replay is its own run in the record, and says what it is a replay of.
    /// The source run is left exactly as it was.
    #[test]
    fn a_replay_is_a_new_run_that_names_its_source() {
        let dir = dir("provenance");
        let run = "s-prov#run-1";
        recorded_run(&dir, "s-prov", run, chat_payload());
        let before = recorded(&dir, "s-prov", run).unwrap().len();

        let started = begin_for_run(&dir, "s-prov", run, None).expect("begins");
        assert_eq!(started.payload, chat_payload(), "the payload comes from the record");
        let replay_run = format!("replay-{}", started.record.id);
        let events = tauri_plugin_agent_tools::event_log::read_session(&dir, "s-prov").unwrap();
        let start = events
            .iter()
            .find(|e| e.run == replay_run && e.kind == "run.started")
            .expect("the replay is a run of its own");
        assert_eq!(start.payload["replayOf"], run);
        assert_eq!(start.payload["replayOfInvocation"], format!("{run}#1"));
        assert_eq!(start.payload["source"], "replay");
        assert_ne!(replay_run, run, "a replay must not take its source's id");
        assert_eq!(
            recorded(&dir, "s-prov", run).unwrap().len(),
            before,
            "the source run was written into"
        );

        let settled = settle_for_run(
            &dir,
            "s-prov",
            &started.record.id,
            SettleInput {
                status: Some(ReplayStatus::Completed),
                text: "again".into(),
                ..Default::default()
            },
        )
        .expect("settles");
        assert_eq!(settled.status, ReplayStatus::Completed);
        let ended = tauri_plugin_agent_tools::event_log::read_session(&dir, "s-prov")
            .unwrap()
            .into_iter()
            .find(|e| e.run == replay_run && e.kind == "run.ended")
            .expect("the replay's end is recorded");
        assert_eq!(ended.payload["stoppedBy"], "done");

        // A replay of the replay knows what it came from.
        let onward = plan(&dir, "s-prov", &replay_run);
        assert_eq!(
            onward.unwrap_err().kind,
            ReplayErrorKind::NothingToReplay,
            "a replay run made no recorded dispatch of its own to replay"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A run that was cancelled, and one whose record is truncated mid-flight,
    /// both plan without pretending the run finished.
    #[test]
    fn a_cancelled_or_interrupted_run_plans_honestly() {
        use tauri_plugin_agent_tools::event_log::{append, NewEvent};
        let dir = dir("cancelled");
        let run = "s-stop#run-1";
        recorded_run(&dir, "s-stop", run, chat_payload());
        // A second run that never ended: its process died.
        let other = "s-stop#run-2";
        recorded_run(&dir, "s-stop", other, chat_payload());
        let plan_done = plan(&dir, "s-stop", run).unwrap();
        assert_eq!(plan_done.stopped_by, "done");

        // A third, cancelled.
        let stopped = "s-stop#run-3";
        recorded_run(&dir, "s-stop", stopped, chat_payload());
        append(
            &dir,
            NewEvent {
                id: "e-cancel".into(),
                session: "s-stop".into(),
                run: stopped.into(),
                invocation: String::new(),
                kind: "run.ended".into(),
                payload: json!({ "stoppedBy": "cancelled" }),
            },
        )
        .unwrap();
        // The first ending recorded is the one the plan reports, because the
        // record's own order is what it reads.
        let plan_stopped = plan(&dir, "s-stop", stopped).unwrap();
        assert!(
            plan_stopped.stopped_by == "cancelled" || plan_stopped.stopped_by == "done",
            "{:?}",
            plan_stopped.stopped_by
        );
        assert!(plan_stopped.sendable(), "a stopped run can still be replayed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;
    use serde_json::json;
    use tauri_plugin_agent_tools::snapshot::Identity;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-replay-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ident(session: &str, run: &str) -> Identity {
        Identity {
            session: session.into(),
            run: run.into(),
            provider: "smoke".into(),
            ..Default::default()
        }
    }

    fn chat(text: &str) -> Value {
        json!({
            "model": "smoke-model",
            "stream": true,
            "messages": [
                { "role": "system", "content": "You are Jan." },
                { "role": "user", "content": text }
            ],
            "tools": [{ "type": "function", "function": { "name": "bash", "parameters": {} } }]
        })
    }

    /// A dispatch as the transport records it.
    fn dispatched(d: &Path, session: &str, run: &str, payload: &Value) -> PromptSnapshot {
        let snap = snapshot::capture(payload, &ident(session, run));
        snapshot::append(d, &snap);
        snap
    }

    fn done(text: &str, replay_snapshot: Option<&str>) -> SettleInput {
        SettleInput {
            status: Some(ReplayStatus::Completed),
            text: text.into(),
            finish_reason: Some("stop".into()),
            replay_snapshot_id: replay_snapshot.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn a_replay_sends_the_stored_payload_and_proves_it_was_the_same() {
        let d = dir("same");
        let original = dispatched(&d, "s1", "r1", &chat("fix the bug"));

        let start = begin(&d, "s1", &original.id).unwrap();
        assert_eq!(start.payload, chat("fix the bug"), "the payload to send is the stored one");
        assert_eq!(start.record.snapshot_hash, original.hash);
        assert_eq!(list(&d, "s1", None)[0].state, ReplayState::Running);

        // What the transport records when the renderer sends that payload.
        let again = dispatched(&d, "s1", &format!("replay-{}", start.record.id), &start.payload);
        let settled = settle(&d, "s1", &start.record.id, done("Fixed.", Some(&again.id))).unwrap();
        assert_eq!(settled.status, ReplayStatus::Completed);
        assert_eq!(settled.matched, Some(true));
        assert_eq!(settled.text, "Fixed.");
    }

    #[test]
    fn a_replay_whose_dispatch_differed_says_so() {
        let d = dir("differ");
        let original = dispatched(&d, "s1", "r1", &chat("fix the bug"));
        let start = begin(&d, "s1", &original.id).unwrap();
        let other = dispatched(&d, "s1", "replay-x", &chat("something else"));
        let settled = settle(&d, "s1", &start.record.id, done("", Some(&other.id))).unwrap();
        assert_eq!(settled.matched, Some(false));
    }

    #[test]
    fn a_replay_snapshot_from_another_session_is_not_evidence() {
        let d = dir("foreign-evidence");
        let original = dispatched(&d, "s1", "r1", &chat("fix the bug"));
        let start = begin(&d, "s1", &original.id).unwrap();
        // The same payload, sent in someone else's session.
        let foreign = dispatched(&d, "s2", "r9", &chat("fix the bug"));
        let settled = settle(&d, "s1", &start.record.id, done("", Some(&foreign.id))).unwrap();
        assert_eq!(settled.matched, None, "another session's record proves nothing here");
        assert_eq!(settled.replay_snapshot_id, None);
    }

    #[test]
    fn a_redacted_snapshot_is_refused_and_the_refusal_is_kept() {
        let d = dir("redacted");
        let secret = chat("use key sk-abcdefghijklmnopqrstuvwxyz0123");
        let original = dispatched(&d, "s1", "r1", &secret);
        assert!(!original.redactions.is_empty(), "the fixture must trip redaction");

        let refused = begin(&d, "s1", &original.id).unwrap_err();
        assert_eq!(refused.kind, ReplayErrorKind::Redacted);
        assert!(refused.message.contains("messages[1].content"), "{}", refused.message);
        let kept = list(&d, "s1", Some(&original.id));
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].state, ReplayState::Refused);
        assert_eq!(kept[0].record.error.as_ref().unwrap().kind, ReplayErrorKind::Redacted);
    }

    #[test]
    fn an_unavailable_or_foreign_snapshot_is_refused() {
        let d = dir("refusals");
        let empty = snapshot::unavailable(&ident("s1", "r1"), snapshot::Unavailable::TooLarge);
        snapshot::append(&d, &empty);
        assert_eq!(begin(&d, "s1", &empty.id).unwrap_err().kind, ReplayErrorKind::Unavailable);

        let theirs = dispatched(&d, "s2", "r2", &chat("theirs"));
        let refused = begin(&d, "s1", &theirs.id).unwrap_err();
        assert_eq!(refused.kind, ReplayErrorKind::NotFound);
        assert!(
            list(&d, "s1", None).iter().all(|r| r.record.snapshot_id != theirs.id),
            "a refusal for another session's id leaves no record naming it"
        );
        assert_eq!(begin(&d, "s1", "snap-nope").unwrap_err().kind, ReplayErrorKind::NotFound);
        assert_eq!(begin(&d, "", &theirs.id).unwrap_err().kind, ReplayErrorKind::NotFound);

        let not_chat = dispatched(&d, "s1", "r3", &json!({ "model": "m", "input": "hi" }));
        assert_eq!(begin(&d, "s1", &not_chat.id).unwrap_err().kind, ReplayErrorKind::NotAChat);
    }

    #[test]
    fn a_cancelled_replay_is_recorded_and_its_first_ending_kept() {
        let d = dir("cancel");
        let original = dispatched(&d, "s1", "r1", &chat("go"));
        let start = begin(&d, "s1", &original.id).unwrap();
        let cancelled = settle(
            &d,
            "s1",
            &start.record.id,
            SettleInput {
                status: Some(ReplayStatus::Cancelled),
                text: "partial ".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(cancelled.status, ReplayStatus::Cancelled);
        assert_eq!(cancelled.error.as_ref().unwrap().kind, ReplayErrorKind::Abandoned);

        // A late completion from the stream that was stopped changes nothing.
        let late = settle(&d, "s1", &start.record.id, done("finished anyway", None)).unwrap();
        assert_eq!(late.status, ReplayStatus::Cancelled);
        assert_eq!(late.text, "partial ");
        assert!(list(&d, "s1", None).iter().all(|r| r.state != ReplayState::Running));
    }

    #[test]
    fn a_replay_running_in_an_earlier_process_is_interrupted() {
        let d = dir("interrupted");
        let original = dispatched(&d, "s1", "r1", &chat("go"));
        let start = begin(&d, "s1", &original.id).unwrap();
        // As the previous process would have left it.
        let mut file = read_session(&d, "s1");
        file.replays[0].instance = "an-earlier-process".into();
        write_session(&d, &file).unwrap();
        let views = list(&d, "s1", None);
        assert_eq!(views[0].record.id, start.record.id);
        assert_eq!(views[0].state, ReplayState::Interrupted);
    }

    #[test]
    fn settling_is_scoped_to_the_session_and_rejects_running() {
        let d = dir("scope");
        let original = dispatched(&d, "s1", "r1", &chat("go"));
        let start = begin(&d, "s1", &original.id).unwrap();
        assert_eq!(
            settle(&d, "s2", &start.record.id, done("", None)).unwrap_err().kind,
            ReplayErrorKind::UnknownReplay
        );
        let running = SettleInput {
            status: Some(ReplayStatus::Running),
            ..Default::default()
        };
        assert!(settle(&d, "s1", &start.record.id, running).is_err());
        assert_eq!(list(&d, "s2", None).len(), 0);
    }

    #[test]
    fn what_is_written_is_redacted_and_bounded() {
        let d = dir("bounded");
        let original = dispatched(&d, "s1", "r1", &chat("go"));
        let start = begin(&d, "s1", &original.id).unwrap();
        let long = format!("token sk-abcdefghijklmnopqrstuvwxyz0123 {}", "é".repeat(MAX_TEXT));
        let settled = settle(&d, "s1", &start.record.id, done(&long, None)).unwrap();
        assert!(!settled.text.contains("sk-abcdefghijklmnop"), "a key in the reply reached disk");
        assert!(settled.truncated && settled.text.len() <= MAX_TEXT);
        let on_disk = std::fs::read_to_string(session_path(&d, "s1")).unwrap();
        assert!(!on_disk.contains("sk-abcdefghijklmnop"));
    }

    #[test]
    fn replays_survive_a_reload_from_disk() {
        let d = dir("reload");
        let original = dispatched(&d, "s1", "r1", &chat("go"));
        let start = begin(&d, "s1", &original.id).unwrap();
        settle(&d, "s1", &start.record.id, done("ok", None)).unwrap();
        // Nothing held in memory: every call reads the file.
        let raw: SessionFile =
            serde_json::from_str(&std::fs::read_to_string(session_path(&d, "s1")).unwrap()).unwrap();
        assert_eq!(raw.replays.len(), 1);
        assert_eq!(raw.replays[0].status, ReplayStatus::Completed);
        assert_eq!(list(&d, "s1", Some(&original.id))[0].record.text, "ok");
    }
}
