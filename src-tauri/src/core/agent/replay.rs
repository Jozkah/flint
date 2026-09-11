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
