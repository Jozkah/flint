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
/// The id of the line that says a log filled up. One per session: writing it
/// twice is one event, like any other repeated id.
const BOUNDARY_ID: &str = "log:truncated";

/// What a log is written under. Production uses [`Limits::standard`]; a test
/// uses a small one, so what happens at the bound is exercised directly rather
/// than by writing 32 MB to find out.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_log_bytes: u64,
    pub max_sessions: usize,
}

impl Limits {
    pub const fn standard() -> Self {
        Self { max_log_bytes: MAX_LOG_BYTES, max_sessions: MAX_SESSIONS }
    }
}

/// Kinds this build writes and understands. Others are kept as they are.
pub const KNOWN_KINDS: &[&str] = &[
    "run.started",
    "run.ended",
    "agent.dispatched",
    "agent.ended",
    "job.started",
    "job.ended",
    // One per model request: the provider's usage (counts only), and what the
    // response was made of (sizes only; the words stay in the transcript).
    "usage.reported",
    // One reply, as it arrived: that it started streaming (and whether content
    // or reasoning came first), how much reasoning the provider supplied, and
    // what the finished message was made of. Sizes and counts only -- the words
    // stay in the transcript, so the log is not a second place they can leak
    // from.
    "message.started",
    "message.reasoning",
    "message.completed",
    // What the run did between provider requests, ordered by the log's own
    // sequence rather than by any writer's clock.
    "steering.received",
    "compaction.started",
    "compaction.succeeded",
    "compaction.failed",
    // One per `activity::Phase`, for a tool call ...
    "tool.requested",
    "tool.queued",
    "tool.awaiting-permission",
    "tool.allowed",
    "tool.refused",
    "tool.running",
    "tool.succeeded",
    "tool.failed",
    "tool.cancelled",
    "tool.stale",
    "tool.timed-out",
    // The log said where it stopped. Not something the run did: something the
    // record did, so a reader can tell a run that ended from one whose log
    // filled up.
    "log.truncated",
    // ... and for something the run itself did (compaction, steering, a
    // subagent or background job stopped): `activity::EventType::Lifecycle`.
    "lifecycle.requested",
    "lifecycle.queued",
    "lifecycle.awaiting-permission",
    "lifecycle.allowed",
    "lifecycle.refused",
    "lifecycle.running",
    "lifecycle.succeeded",
    "lifecycle.failed",
    "lifecycle.cancelled",
    "lifecycle.stale",
    "lifecycle.timed-out",
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

/// Keep only the newest `max_sessions` logs.
fn prune(dir: &Path, keep: &Path, max_sessions: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if logs.len() <= max_sessions {
        return;
    }
    logs.sort();
    let excess = logs.len() - max_sessions;
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
    append_within(data_folder, event, Limits::standard())
}

/// [`append`], under explicit bounds.
pub fn append_within(
    data_folder: &Path,
    event: NewEvent,
    limits: Limits,
) -> Result<Envelope, LogError> {
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
    if state.bytes + line.len() as u64 > limits.max_log_bytes {
        // A log that simply stops is indistinguishable from a run that did, so
        // it says where it ended -- once, in the same envelope as every other
        // line, so what is there stays readable JSONL and a reader that knows
        // the kind can say why the record goes no further.
        if !state.ids.contains(BOUNDARY_ID) {
            let boundary = Envelope {
                v: ENVELOPE_VERSION,
                id: BOUNDARY_ID.to_string(),
                session: envelope.session.clone(),
                run: String::new(),
                invocation: String::new(),
                seq: envelope.seq,
                at: crate::audit::now(),
                kind: "log.truncated".to_string(),
                payload: serde_json::json!({
                    "reason": "the session's event log is full",
                    "limitBytes": limits.max_log_bytes,
                }),
                redactions: Vec::new(),
            };
            if let Ok(mut mark) = serde_json::to_string(&boundary) {
                mark.push('\n');
                if let Ok(mut file) =
                    std::fs::OpenOptions::new().create(true).append(true).open(&path)
                {
                    if file.write_all(mark.as_bytes()).is_ok() {
                        let _ = file.flush();
                        state.last_seq = boundary.seq;
                        state.ids.insert(boundary.id);
                        state.bytes += mark.len() as u64;
                    }
                }
            }
        }
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
        prune(&events_dir(data_folder), &path, limits.max_sessions);
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

/// Forget what this process loaded, as a restart would. Tests only.
#[cfg(test)]
pub(crate) fn forget_loaded() {
    STATE.lock().unwrap_or_else(|p| p.into_inner()).clear();
}

/// Every session's events, each log read under the same rules as
/// [`read_session`]. A log that cannot be read is reported and skipped, so one
/// damaged session never hides the others. Order: by session log, then `seq`.
pub fn read_all_sessions(data_folder: &Path) -> Vec<Envelope> {
    let Ok(entries) = std::fs::read_dir(events_dir(data_folder)) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    paths.sort();
    let mut out = Vec::new();
    for path in paths {
        // The session is named by the log's own first envelope; read_session
        // then holds every line to it.
        let first = std::fs::File::open(&path).ok().and_then(|f| {
            std::io::BufReader::new(f)
                .lines()
                .map_while(Result::ok)
                .find(|l| !l.trim().is_empty())
                .and_then(|l| decode_line(&l).ok())
        });
        let Some(first) = first else { continue };
        if log_path(data_folder, &first.session) != path {
            eprintln!("event log: {} is not the log of the session it holds", path.display());
            continue;
        }
        match read_session(data_folder, &first.session) {
            Ok(events) => out.extend(events),
            Err(e) => eprintln!("event log: {} cannot be read: {}", path.display(), e.message()),
        }
    }
    out
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
            Phase::Queued,
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
            for prefix in ["tool", "lifecycle"] {
                let kind = format!("{prefix}.{}", name.as_str().unwrap());
                assert!(KNOWN_KINDS.contains(&kind.as_str()), "{kind} is not a known kind");
            }
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

    /// AH-004: a session's log is bounded. What is already there stays
    /// readable, one line says why the record goes no further, and nothing
    /// after it is accepted -- a log that filled up must not look like a run
    /// that ended.
    #[test]
    fn a_full_log_stops_at_a_readable_boundary() {
        let d = dir("full");
        // Room for the first event and nothing much more.
        let first = append_within(&d, ev("a", "s1", "run.started", json!({})), Limits::standard())
            .unwrap();
        let used = std::fs::metadata(log_path(&d, "s1")).unwrap().len();
        let tight = Limits { max_log_bytes: used + 8, max_sessions: MAX_SESSIONS };
        assert_eq!(
            append_within(&d, ev("b", "s1", "tool.requested", json!({})), tight),
            Err(LogError::TooLarge)
        );
        // A second attempt is refused the same way and adds no second marker.
        assert_eq!(
            append_within(&d, ev("c", "s1", "tool.succeeded", json!({})), tight),
            Err(LogError::TooLarge)
        );
        let back = read_session(&d, "s1").unwrap();
        assert_eq!(
            back.iter().map(|e| (e.id.as_str(), e.kind.as_str())).collect::<Vec<_>>(),
            [("a", "run.started"), (BOUNDARY_ID, "log.truncated")],
            "{back:?}"
        );
        assert_eq!(back[0], first, "what was already recorded is unchanged");
        assert!(back[1].is_known(), "the boundary is a kind readers know");
        let raw = std::fs::read_to_string(log_path(&d, "s1")).unwrap();
        assert!(
            raw.lines().filter(|l| !l.trim().is_empty()).all(|l| decode_line(l).is_ok()),
            "the log stopped being JSONL: {raw}"
        );
        // And it is still the log it was after a restart.
        restart();
        assert_eq!(read_session(&d, "s1").unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// AH-004: the number of session logs is bounded, oldest first, and the
    /// log being written is never the one removed.
    #[test]
    fn the_oldest_session_logs_are_removed_once_there_are_too_many() {
        let d = dir("sessions");
        let small = Limits { max_log_bytes: MAX_LOG_BYTES, max_sessions: 2 };
        for session in ["s1", "s2"] {
            append_within(&d, ev("a", session, "run.started", json!({})), small).unwrap();
            // Distinct modification times: the oldest is removed by when it
            // was last written, which needs the clock to have moved.
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        append_within(&d, ev("a", "s3", "run.started", json!({})), small).unwrap();
        assert!(read_session(&d, "s1").unwrap().is_empty(), "the oldest log survived");
        for kept in ["s2", "s3"] {
            assert_eq!(read_session(&d, kept).unwrap().len(), 1, "{kept} was removed instead");
        }
        // The standard bound removes nothing at this size.
        append_within(&d, ev("b", "s4", "run.started", json!({})), Limits::standard()).unwrap();
        assert_eq!(read_session(&d, "s2").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A log written before this build's kinds existed still reads, and its
    /// events keep their order beside new ones. The envelope is the contract;
    /// the vocabulary is not.
    #[test]
    fn a_log_from_an_older_build_reads_and_continues() {
        let d = dir("migrate");
        let path = log_path(&d, "s1");
        std::fs::create_dir_all(events_dir(&d)).unwrap();
        // Written by a build that had no invocation ids and no `redactions`.
        std::fs::write(
            &path,
            "{\"v\":1,\"id\":\"old-1\",\"session\":\"s1\",\"seq\":1,\"at\":\"2026-01-01T00:00:00Z\",\"kind\":\"run.started\",\"payload\":{}}\n",
        )
        .unwrap();
        restart();
        let back = read_session(&d, "s1").unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].invocation, "", "an absent field reads as empty, not as an error");
        assert!(back[0].redactions.is_empty());
        let next = append(&d, ev("new-1", "s1", "message.started", json!({ "first": "content" }))).unwrap();
        assert_eq!(next.seq, 2, "the sequence continues from what was already there");
        let after = read_session(&d, "s1").unwrap();
        let kinds: Vec<&str> = after.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["run.started", "message.started"]);
        let _ = std::fs::remove_dir_all(&d);
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
