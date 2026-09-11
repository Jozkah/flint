//! One versioned envelope for what happened in a session, persisted. AH-005.
//!
//! The run's canonical events -- a run starting and ending, each tool call's
//! phases, approvals, dispatched agents, background jobs -- are written here
//! as one JSON line each, in a per-session log under `<data>/events/`. The
//! envelope is the contract with every later reader (export, inspection,
//! replay), so it is small, explicit and versioned:
//!
//! * `v` -- the envelope version. A reader that meets a newer version fails
//!   with a typed error rather than guessing at a framing it does not know.
//! * `id` -- stable, given by the writer. Writing the same id twice is one
//!   event, so a retried write cannot duplicate history.
//! * `session`, `run`, `invocation` -- who it belongs to.
//! * `seq` -- assigned here, strictly increasing within a session, so the
//!   order is the log's and not whichever clock a writer had.
//! * `at` -- RFC 3339, UTC, when it was recorded.
//! * `kind` -- a short dotted name. A kind this build does not know is kept
//!   and read back verbatim: the log outlives the build that wrote it.
//! * `payload` -- redacted before it is written, with `redactions` naming
//!   the fields that were removed, and bounded in size.
//!
//! A process that dies mid-write leaves at most a torn last line. Readers skip
//! it, and the next write in a later process cuts it off before appending, so
//! one crash never corrupts what came before. Each session's log is bounded,
//! and the oldest session logs are removed once there are too many.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const ENVELOPE_VERSION: u16 = 1;
/// A payload larger than this is replaced by a note saying so.
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
/// A session's log stops accepting events at this size.
pub const MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;
/// Session logs kept; the least recently written go first.
pub const MAX_SESSIONS: usize = 500;

/// Kinds this build writes and understands. Others are kept as they are.
pub const KNOWN_KINDS: &[&str] = &[
    "run.started",
    "run.ended",
    "agent.dispatched",
    "agent.ended",
    "job.started",
    "job.ended",
    // One per `activity::Phase`.
    "tool.requested",
    "tool.awaiting-permission",
    "tool.allowed",
    "tool.refused",
    "tool.running",
    "tool.succeeded",
    "tool.failed",
    "tool.cancelled",
    "tool.stale",
    "tool.timed-out",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u16,
    pub id: String,
    pub session: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub invocation: String,
    pub seq: u64,
    pub at: String,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub redactions: Vec<String>,
}

impl Envelope {
    pub fn is_known(&self) -> bool {
        KNOWN_KINDS.contains(&self.kind.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "detail")]
pub enum LogError {
    /// An envelope written by a newer build.
    UnsupportedVersion(u16),
    /// A line that is not an envelope, other than a torn last line.
    Corrupt(String),
    /// The session's log is full.
    TooLarge,
    /// A field that cannot be recorded as given.
    InvalidInput(String),
    Io(String),
}

impl LogError {
    pub fn message(&self) -> String {
        match self {
            LogError::UnsupportedVersion(v) => format!("event envelope version {v} is newer than this build reads"),
            LogError::Corrupt(l) => format!("a line of the event log is not an event: {l}"),
            LogError::TooLarge => "the session's event log is full".into(),
            LogError::InvalidInput(m) => m.clone(),
            LogError::Io(e) => format!("could not use the event log: {e}"),
        }
    }
}

/// What a writer supplies. The log assigns `seq` and `at`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub id: String,
    pub session: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub invocation: String,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

pub fn events_dir(data_folder: &Path) -> PathBuf {
    data_folder.join("events")
}

pub fn log_path(data_folder: &Path, session: &str) -> PathBuf {
    events_dir(data_folder).join(format!("{}.jsonl", &sha256_hex(session.as_bytes())[..24]))
}

fn valid_token(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}

fn valid_kind(kind: &str) -> bool {
    !kind.is_empty()
        && kind.len() <= 64
        && kind.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '_'))
}

/// One line of the log, strictly: a newer envelope version is an error, an
/// unknown kind is not.
pub fn decode_line(line: &str) -> Result<Envelope, LogError> {
    let raw: Value = serde_json::from_str(line)
        .map_err(|_| LogError::Corrupt(line.chars().take(80).collect()))?;
    let v = raw.get("v").and_then(Value::as_u64).unwrap_or(0);
    if v > u64::from(ENVELOPE_VERSION) {
        return Err(LogError::UnsupportedVersion(v.min(u64::from(u16::MAX)) as u16));
    }
    if v == 0 {
        return Err(LogError::Corrupt(line.chars().take(80).collect()));
    }
    serde_json::from_value(raw).map_err(|_| LogError::Corrupt(line.chars().take(80).collect()))
}

/// Per session, what the log already holds: the last sequence number and the
/// ids written, loaded once per process.
struct SessionState {
    last_seq: u64,
    ids: BTreeSet<String>,
    bytes: u64,
}

static STATE: Mutex<BTreeMap<String, SessionState>> = Mutex::new(BTreeMap::new());

/// Read a log, cutting off a torn final line first so the next append starts
/// on a line of its own.
fn load(path: &Path) -> Result<SessionState, LogError> {
    let io = |e: std::io::Error| LogError::Io(e.to_string());
    let mut state = SessionState { last_seq: 0, ids: BTreeSet::new(), bytes: 0 };
    let Ok(bytes) = std::fs::read(path) else {
        return Ok(state);
    };
    let mut keep = bytes.len();
    if !bytes.is_empty() && bytes[bytes.len() - 1] != b'\n' {
        keep = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let file = std::fs::OpenOptions::new().write(true).open(path).map_err(io)?;
        file.set_len(keep as u64).map_err(io)?;
    }
    for line in String::from_utf8_lossy(&bytes[..keep]).lines().filter(|l| !l.trim().is_empty()) {
        if let Ok(e) = decode_line(line) {
            state.last_seq = state.last_seq.max(e.seq);
            state.ids.insert(e.id);
        }
    }
    state.bytes = keep as u64;
    Ok(state)
}

/// Keep only the newest `MAX_SESSIONS` logs.
fn prune(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if logs.len() <= MAX_SESSIONS {
        return;
    }
    logs.sort();
    let excess = logs.len() - MAX_SESSIONS;
    for (_, path) in logs.into_iter().take(excess) {
        if path != keep {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Bound a payload, noting what was dropped.
fn bounded(payload: Value) -> Value {
    let size = serde_json::to_vec(&payload).map(|v| v.len()).unwrap_or(0);
    if size <= MAX_PAYLOAD_BYTES {
        return payload;
    }
    serde_json::json!({ "truncated": true, "bytes": size })
}

/// Record an event. Returns the envelope as stored; an id already in the log
/// returns without writing again.
pub fn append(data_folder: &Path, event: NewEvent) -> Result<Envelope, LogError> {
    if !valid_token(&event.id, 200) || !valid_token(&event.session, 200) {
        return Err(LogError::InvalidInput("an event needs an id and a session".into()));
    }
    if event.run.len() > 200 || event.invocation.len() > 200 {
        return Err(LogError::InvalidInput("an event's run or invocation is too long".into()));
    }
    if !valid_kind(&event.kind) {
        return Err(LogError::InvalidInput(format!("{:?} is not an event kind", event.kind)));
    }
    let (payload, found) = crate::snapshot::redact_payload(&event.payload);
    let payload = bounded(payload);
    let path = log_path(data_folder, &event.session);
    let io = |e: std::io::Error| LogError::Io(e.to_string());
    std::fs::create_dir_all(events_dir(data_folder)).map_err(io)?;

    let mut states = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let key = path.to_string_lossy().to_string();
    if !states.contains_key(&key) {
        let loaded = load(&path)?;
        states.insert(key.clone(), loaded);
    }
    let state = states.get_mut(&key).expect("inserted above");
    if state.ids.contains(&event.id) {
        drop(states);
        return read_session(data_folder, &event.session)?
            .into_iter()
            .find(|e| e.id == event.id)
            .ok_or_else(|| LogError::Io("the event was recorded but cannot be read back".into()));
    }
    let envelope = Envelope {
        v: ENVELOPE_VERSION,
        id: event.id,
        session: event.session,
        run: event.run,
        invocation: event.invocation,
        seq: state.last_seq + 1,
        at: crate::audit::now(),
        kind: event.kind,
        payload,
        redactions: found.into_iter().map(|r| r.path).collect(),
    };
    let mut line = serde_json::to_string(&envelope).map_err(|e| LogError::Io(e.to_string()))?;
    line.push('\n');
    if state.bytes + line.len() as u64 > MAX_LOG_BYTES {
        return Err(LogError::TooLarge);
    }
    let fresh = !path.exists();
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(io)?;
    file.write_all(line.as_bytes()).map_err(io)?;
    file.flush().map_err(io)?;
    state.last_seq = envelope.seq;
    state.ids.insert(envelope.id.clone());
    state.bytes += line.len() as u64;
    drop(states);
    if fresh {
        prune(&events_dir(data_folder), &path);
    }
    Ok(envelope)
}

/// A session's events in log order. A torn last line is skipped; any other
/// line that is not an envelope is an error, as is a newer version.
pub fn read_session(data_folder: &Path, session: &str) -> Result<Vec<Envelope>, LogError> {
    let Ok(file) = std::fs::File::open(log_path(data_folder, session)) else {
        return Ok(Vec::new());
    };
    let lines: Vec<String> = std::io::BufReader::new(file).lines().map_while(Result::ok).collect();
    let mut out = Vec::with_capacity(lines.len());
    let last = lines.iter().rposition(|l| !l.trim().is_empty());
    for (i, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match decode_line(line) {
            Ok(e) if e.session == session => out.push(e),
            Ok(_) => return Err(LogError::Corrupt("an event of another session".into())),
            // Only the last line can be torn by a crash.
            Err(LogError::Corrupt(_)) if Some(i) == last => {}
            Err(e) => return Err(e),
        }
    }
    let mut seen = BTreeSet::new();
    out.retain(|e| seen.insert(e.id.clone()));
    out.sort_by_key(|e| e.seq);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-events-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ev(id: &str, session: &str, kind: &str, payload: Value) -> NewEvent {
        NewEvent { id: id.into(), session: session.into(), run: "r1".into(), invocation: String::new(), kind: kind.into(), payload }
    }

    /// Forget what this process loaded, as a restart would.
    fn restart() {
        STATE.lock().unwrap().clear();
    }

    /// Every tool phase the activity record can hold is a kind this build
    /// knows, so the two vocabularies cannot drift apart unnoticed.
    #[test]
    fn every_tool_phase_is_a_known_kind() {
        use crate::activity::Phase;
        for phase in [
            Phase::Requested,
            Phase::AwaitingPermission,
            Phase::Allowed,
            Phase::Refused,
            Phase::Running,
            Phase::Succeeded,
            Phase::Failed,
            Phase::Cancelled,
            Phase::Stale,
            Phase::TimedOut,
        ] {
            let name = serde_json::to_value(phase).unwrap();
            let kind = format!("tool.{}", name.as_str().unwrap());
            assert!(KNOWN_KINDS.contains(&kind.as_str()), "{kind} is not a known kind");
        }
    }

    #[test]
    fn events_come_back_in_order_with_their_envelope() {
        let d = dir("order");
        for (i, kind) in ["run.started", "tool.requested", "tool.succeeded", "run.ended"].iter().enumerate() {
            let e = append(&d, ev(&format!("e{i}"), "s1", kind, json!({ "n": i }))).unwrap();
            assert_eq!(e.seq, i as u64 + 1);
            assert_eq!(e.v, ENVELOPE_VERSION);
        }
        let back = read_session(&d, "s1").unwrap();
        assert_eq!(back.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["run.started", "tool.requested", "tool.succeeded", "run.ended"]);
        assert!(back.windows(2).all(|w| w[0].seq < w[1].seq));
        assert!(read_session(&d, "other").unwrap().is_empty(), "sessions do not see each other");
    }

    #[test]
    fn the_same_id_is_one_event_even_across_a_restart() {
        let d = dir("dedup");
        let a = append(&d, ev("same", "s1", "run.started", json!({}))).unwrap();
        let b = append(&d, ev("same", "s1", "run.started", json!({ "different": true }))).unwrap();
        assert_eq!(a, b);
        restart();
        let c = append(&d, ev("same", "s1", "run.started", json!({}))).unwrap();
        assert_eq!(a.seq, c.seq);
        let next = append(&d, ev("next", "s1", "run.ended", json!({}))).unwrap();
        assert_eq!(next.seq, 2, "the sequence continues after a restart");
        assert_eq!(read_session(&d, "s1").unwrap().len(), 2);
    }

    #[test]
    fn a_torn_last_line_is_skipped_and_cut_off_by_the_next_write() {
        let d = dir("torn");
        append(&d, ev("a", "s1", "run.started", json!({}))).unwrap();
        append(&d, ev("b", "s1", "tool.requested", json!({}))).unwrap();
        // A process died mid-write.
        let path = log_path(&d, "s1");
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{\"v\":1,\"id\":\"c\",\"sess").unwrap();
        drop(f);
        assert_eq!(read_session(&d, "s1").unwrap().len(), 2, "the torn line is skipped, the rest kept");
        restart();
        let c = append(&d, ev("c", "s1", "tool.succeeded", json!({}))).unwrap();
        assert_eq!(c.seq, 3);
        let back = read_session(&d, "s1").unwrap();
        assert_eq!(back.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert!(std::fs::read_to_string(&path).unwrap().lines().all(|l| decode_line(l).is_ok()));
    }

    #[test]
    fn an_unknown_kind_is_kept_and_a_newer_envelope_is_refused() {
        let d = dir("versions");
        let e = append(&d, ev("x", "s1", "future.thing", json!({ "shape": "new" }))).unwrap();
        assert!(!e.is_known());
        assert_eq!(read_session(&d, "s1").unwrap()[0].payload, json!({ "shape": "new" }));
        assert_eq!(
            decode_line(r#"{"v":2,"id":"y","session":"s1","seq":9,"at":"t","kind":"run.started"}"#),
            Err(LogError::UnsupportedVersion(2))
        );
        // In the middle of a log, a corrupt line is an error, not a silent gap.
        let path = log_path(&d, "s1");
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"not an event\n{\"v\":1,\"id\":\"z\",\"session\":\"s1\",\"seq\":5,\"at\":\"t\",\"kind\":\"run.ended\"}\n").unwrap();
        assert!(matches!(read_session(&d, "s1"), Err(LogError::Corrupt(_))));
    }

    #[test]
    fn what_is_written_is_redacted_bounded_and_refused_when_malformed() {
        let d = dir("redact");
        let e = append(&d, ev("k", "s1", "tool.requested", json!({ "summary": "use sk-abcdefghijklmnopqrstuvwxyz0123", "apiKey": "x" }))).unwrap();
        let on_disk = std::fs::read_to_string(log_path(&d, "s1")).unwrap();
        assert!(!on_disk.contains("sk-abcdefghijklmnop"));
        assert!(!e.redactions.is_empty());
        let big = "x".repeat(MAX_PAYLOAD_BYTES + 10);
        let e = append(&d, ev("big", "s1", "tool.requested", json!({ "text": big }))).unwrap();
        assert_eq!(e.payload["truncated"], true);
        for bad in [ev("", "s1", "run.started", json!({})), ev("a1", "", "run.started", json!({})), ev("a2", "s1", "Run Started", json!({}))] {
            assert!(matches!(append(&d, bad), Err(LogError::InvalidInput(_))));
        }
    }
}
