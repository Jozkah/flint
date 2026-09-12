//! What every tool execution did, recorded as it happens. AH-050.
//!
//! `audit.rs` records permission *decisions*; this records the *lifecycle* of
//! the call itself, so a completed run can be replayed without the transcript
//! and without the model's own account of what it did. One call is one item
//! that moves through phases -- it is never replaced by its result, and a
//! result arriving out of order does not reorder anything, because ordering
//! comes from when the call was requested.
//!
//! It is also the one execution-event model the desktop timeline and the
//! Background Tasks panel read (AH-172): besides tool calls it carries the
//! run's own lifecycle events -- compaction, steering, subagent dispatch and
//! end, background jobs starting and stopping -- as items of their own, in the
//! same sequence.
//!
//! # Where it is stored
//!
//! The session's canonical event log (`event_log`, AH-005) is the only store
//! this record is written to. Each transition is one envelope there: kind
//! `tool.<phase>` for a tool call and `lifecycle.<phase>` for something the
//! run itself did, id `tool:<call>:<phase>` / `life:<call>:<phase>`, and this
//! module's event as the payload. The envelope gives the one sequence, the
//! stable id (a retried record is one event), the version and the bounds; the
//! items below are a projection folded from it, never a second truth.
//!
//! `<data>/audit/tool-activity.jsonl` is the store this record used before the
//! two were consolidated. It is read, never rewritten, so a timeline recorded
//! by an older build still loads; a transition present in both (older builds
//! wrote each one to both) counts once. The only new lines it receives are
//! events with no session, which have no session log to live in.
//!
//! Inputs and outputs are redacted and bounded before they are written; a file
//! change's unified diff is stored beside the log, one file per call, and
//! never inline.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::audit::{now, redact};
use crate::event_log::{self, Envelope, NewEvent};

/// Version 2 adds the sequence, input/output, lifecycle and change fields.
/// Every one of them is optional on the way in, so version-1 lines still read.
pub const SCHEMA_VERSION: u32 = 2;

/// Longest input kept on an event: enough to show what was asked.
pub const MAX_INPUT_BYTES: usize = 4 * 1024;
/// Longest output kept on an event: the end, where a command says how it went.
pub const MAX_OUTPUT_BYTES: usize = 16 * 1024;
/// Largest diff stored for one call. Past this the change is recorded as
/// oversized, with its counts, and the diff itself is not kept.
pub const MAX_DIFF_BYTES: usize = 512 * 1024;

/// Where a call has got to.
///
/// Deliberately not collapsed into "done": a refusal, a cancellation and a
/// failure are different things to have happened, and a timeline that shows
/// them alike cannot answer "what went wrong" or "what did I not allow".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// The model asked for the call. Always the first event of an item.
    Requested,
    /// Queued behind other work (a subagent waiting for a slot).
    Queued,
    /// Waiting on the user to allow or refuse it.
    AwaitingPermission,
    Allowed,
    Refused,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    /// The run that owned the call is gone, so nothing will finish it.
    Stale,
    TimedOut,
}

impl Phase {
    /// Whether this phase ends the item. A terminal phase is the last event a
    /// call can legitimately produce.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Phase::Refused
                | Phase::Succeeded
                | Phase::Failed
                | Phase::Cancelled
                | Phase::Stale
                | Phase::TimedOut
        )
    }

    /// Whether the timeline may hide this when asked to hide completed work.
    /// Only a clean success: everything else is something someone needs to see.
    pub fn is_hideable(self) -> bool {
        self == Phase::Succeeded
    }
}

/// A tool call, or something the run itself did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum EventType {
    #[default]
    Tool,
    /// Compaction, steering, a subagent dispatched or ended, a background job
    /// started or stopped. `lifecycle` names which.
    Lifecycle,
}

/// What a call did to one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// As the tool resolved it, relative where possible. Redacted like any
    /// other resource.
    pub path: String,
    /// `created` / `edited` / `deleted` / `renamed` / `binary`.
    pub kind: String,
    /// Where a rename came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Lines added and removed, counted from the diff this call produced --
    /// not from the repository's state now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
    /// The unified diff is stored and can be read back (`read_diff`).
    #[serde(default)]
    pub diff_stored: bool,
    /// The diff was larger than `MAX_DIFF_BYTES` and was not kept.
    #[serde(default)]
    pub oversized: bool,
}

/// One lifecycle event of one tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolActivityEvent {
    #[serde(rename = "v")]
    pub version: u32,
    /// RFC 3339, UTC.
    pub at: String,
    /// The same instant in milliseconds, when the writer knew it. Absent on
    /// older lines, which only had `at` to the second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<u64>,
    /// Position in the log, assigned when the event is written. Absent on
    /// lines written before sequence numbers existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,

    // -- identity ---------------------------------------------------------
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub run: String,
    /// The tool call. Every event of one call shares this, which is what makes
    /// the item durable rather than a series of unrelated rows.
    pub call: String,
    /// The model dispatch the call came from, joining this to its snapshot.
    #[serde(default)]
    pub invocation: String,
    #[serde(default)]
    pub agent: String,
    /// The agent's durable identity (AH-110): `agent`, `agent:<name>` or
    /// `role:<name>`. Empty on events written before it was recorded, and on
    /// events that are not an agent's.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub agent_id: String,
    #[serde(default)]
    pub project: String,
    /// Which surface recorded it: `cowork`, `chat`, `cli`, `subagent`.
    #[serde(default)]
    pub source: String,
    /// The workflow or task this belongs under (a subagent's dispatching
    /// call, a background job's starting call).
    #[serde(default)]
    pub parent: String,
    /// A call this one replaces -- a retry of a failed call.
    #[serde(default)]
    pub supersedes: String,

    // -- what was asked ----------------------------------------------------
    #[serde(default)]
    pub event_type: EventType,
    /// For a lifecycle event: `compaction`, `steering`, `subagent`,
    /// `background-job`, `approval`, ...
    #[serde(default)]
    pub lifecycle: String,
    pub tool: String,
    /// `read` / `write` / `exec` / `net`, from the tool's capability.
    #[serde(default)]
    pub capability: String,
    /// `path` / `command` / `mcp` / `net` / `process` / `unknown`.
    #[serde(default)]
    pub kind: String,
    /// The normalized resource, redacted.
    #[serde(default)]
    pub resource: String,
    /// A short human-readable account of the action, redacted.
    #[serde(default)]
    pub summary: String,
    /// The call's arguments, redacted and bounded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,

    // -- what happened -----------------------------------------------------
    pub phase: Phase,
    /// Milliseconds from `requested` to this event, when the caller knows.
    #[serde(default)]
    pub elapsed_ms: Option<u64>,
    /// Exit status, for a call that ran a command.
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// Why it failed or was refused, redacted. Never the tool's whole output.
    #[serde(default)]
    pub detail: String,
    /// On a `refused` event the harness chose: the refusal's kind
    /// (`tool-not-offered`, `invalid-call`, ...), so a reader branches on it
    /// instead of parsing `detail`. Absent for a person's refusal and on
    /// older lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<String>,
    /// What the call returned: its end, redacted, bounded to
    /// `MAX_OUTPUT_BYTES`. Absent when nothing was recorded -- which reads as
    /// "unavailable", never as an empty success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// `output` is the end of something longer.
    #[serde(default)]
    pub output_truncated: bool,
    /// A background job this call started or collected.
    #[serde(default)]
    pub job_id: String,
    /// A subagent task this call dispatched.
    #[serde(default)]
    pub task_id: String,
    /// The file the call changed, and how.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<FileChange>,
    /// The unified diff of `change`, as handed in by the caller. Taken off the
    /// event on the way to disk and stored beside the log; never written into
    /// the JSONL line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

impl ToolActivityEvent {
    /// Build an event, redacting the free-text fields on the way in.
    ///
    /// Redaction happens here rather than at render time because the file
    /// outlives the window: anything written unredacted stays that way.
    pub fn new(call: impl Into<String>, tool: impl Into<String>, phase: Phase) -> Self {
        Self {
            version: SCHEMA_VERSION,
            at: now(),
            at_ms: Some(now_ms()),
            seq: None,
            session: String::new(),
            run: String::new(),
            agent_id: String::new(),
            call: call.into(),
            invocation: String::new(),
            agent: String::new(),
            project: String::new(),
            source: String::new(),
            parent: String::new(),
            supersedes: String::new(),
            event_type: EventType::Tool,
            lifecycle: String::new(),
            tool: tool.into(),
            capability: String::new(),
            kind: String::new(),
            resource: String::new(),
            summary: String::new(),
            input: None,
            phase,
            elapsed_ms: None,
            exit_code: None,
            detail: String::new(),
            refusal: None,
            output: None,
            output_truncated: false,
            job_id: String::new(),
            task_id: String::new(),
            change: None,
            diff: None,
        }
    }

    /// Redact every free-text field and bound the large ones. Applied to every
    /// event before it is written, whoever built it.
    pub fn redacted(mut self) -> Self {
        self.resource = redact(&self.resource);
        self.summary = redact(&self.summary);
        self.detail = redact(&self.detail);
        self.input = self.input.map(|i| bound_head(&redact(&i), MAX_INPUT_BYTES));
        if let Some(out) = self.output.take() {
            let (kept, cut) = bound_tail(&redact(&out), MAX_OUTPUT_BYTES);
            self.output = Some(kept);
            self.output_truncated |= cut;
        }
        if let Some(change) = self.change.as_mut() {
            change.path = redact(&change.path);
            change.from = change.from.as_deref().map(redact);
        }
        self.diff = self.diff.map(|d| redact(&d));
        self
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The first `max` bytes, on a character boundary, marked when cut.
fn bound_head(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// The last `max` bytes, on a character boundary, and whether anything went.
fn bound_tail(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_string(), true)
}

/// What a unified diff did to its file, from its own headers: a hunk that
/// starts from nothing (`@@ -0,0`, or `--- /dev/null`) created it, one that
/// ends in nothing deleted it, anything else edited it. The caller's own
/// `change.kind` wins when it gave one.
pub fn change_kind_of(diff: &str) -> &'static str {
    let created = diff.lines().any(|l| l.starts_with("--- /dev/null"))
        || diff.lines().find(|l| l.starts_with("@@")).is_some_and(|h| h.starts_with("@@ -0,0 "));
    let deleted = diff.lines().any(|l| l.starts_with("+++ /dev/null"))
        || diff.lines().find(|l| l.starts_with("@@")).is_some_and(|h| h.contains(" +0,0 @@"));
    if created {
        "created"
    } else if deleted {
        "deleted"
    } else {
        "edited"
    }
}

/// Lines added and removed by a unified diff.
pub fn diff_counts(diff: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

pub fn log_path(data_folder: &Path) -> PathBuf {
    data_folder.join("audit").join("tool-activity.jsonl")
}

/// Where one call's diff is stored. Both parts are reduced to a safe file
/// name, so a session or call id can never name a path outside the folder.
pub fn diff_path(data_folder: &Path, session: &str, call: &str) -> PathBuf {
    let safe = |s: &str| -> String {
        let cleaned: String = s
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .take(96)
            .collect();
        if cleaned.is_empty() { "_".to_string() } else { cleaned }
    };
    data_folder
        .join("audit")
        .join("diffs")
        .join(safe(session))
        .join(format!("{}.diff", safe(call)))
}

/// A call's stored diff, when one was kept.
pub fn read_diff(data_folder: &Path, session: &str, call: &str) -> Option<String> {
    std::fs::read_to_string(diff_path(data_folder, session, call)).ok()
}

/// The next sequence number of the legacy log, known once per process.
fn sequences() -> &'static Mutex<HashMap<PathBuf, u64>> {
    static SEQ: std::sync::OnceLock<Mutex<HashMap<PathBuf, u64>>> = std::sync::OnceLock::new();
    SEQ.get_or_init(|| Mutex::new(HashMap::new()))
}

fn phase_name(phase: Phase) -> String {
    serde_json::to_value(phase)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The envelope kind and id one transition is written under. The id is the
/// same for a retried record, so the log keeps it once.
///
/// A provider's call id is not unique within a session: a local server or a
/// fixture numbers calls from zero in every response, and two subagents of
/// one run share the parent's session. So a tool transition's id names the
/// run, the agent and the request (invocation) as well as the call; only a
/// repeat of all of them is the same event. Lifecycle ids are chosen by the
/// recorder and are already unique.
pub fn envelope_identity(event: &ToolActivityEvent) -> (String, String) {
    let phase = phase_name(event.phase);
    match event.event_type {
        EventType::Tool => (
            format!("tool.{phase}"),
            format!("tool:{}:{}:{}:{}:{phase}", event.run, event.agent, event.invocation, event.call),
        ),
        EventType::Lifecycle => (format!("lifecycle.{phase}"), format!("life:{}:{phase}", event.call)),
    }
}

/// Room kept under the envelope's payload limit for the envelope's own
/// bookkeeping and for redaction markers.
const PAYLOAD_HEADROOM: usize = 4 * 1024;

/// The event as an envelope payload: without the diff (stored beside the log)
/// and without a sequence (the envelope's is the one that counts), cut down
/// further if it would not fit, so a transition is never replaced by the log's
/// "too large" note and lost from the timeline.
fn payload_of(event: &ToolActivityEvent) -> Value {
    let mut event = event.clone();
    event.diff = None;
    event.seq = None;
    let limit = event_log::MAX_PAYLOAD_BYTES - PAYLOAD_HEADROOM;
    let size = |e: &ToolActivityEvent| serde_json::to_vec(e).map(|v| v.len()).unwrap_or(usize::MAX);
    if size(&event) > limit {
        if let Some(out) = event.output.take() {
            let (kept, cut) = bound_tail(&out, MAX_OUTPUT_BYTES / 4);
            event.output = Some(kept);
            event.output_truncated |= cut;
        }
        event.input = event.input.map(|i| bound_head(&i, MAX_INPUT_BYTES / 4));
        event.detail = bound_head(&event.detail, 4 * 1024);
        event.summary = bound_head(&event.summary, 2 * 1024);
        event.resource = bound_head(&event.resource, 2 * 1024);
    }
    serde_json::to_value(&event).unwrap_or(Value::Null)
}

/// Record one event. A failure to write is reported, never swallowed into a
/// silent gap in the record.
pub fn append(data_folder: &Path, event: &ToolActivityEvent) {
    if let Err(e) = record(data_folder, event) {
        eprintln!("tool activity: could not record {:?}: {e}", event.phase);
    }
}

/// Record one event in the session's canonical log.
///
/// This is the only writer: the renderer's `tool_activity_record` and the
/// restart settlement both come through here, so no second store can reach a
/// different terminal status for the same call.
pub fn record(data_folder: &Path, event: &ToolActivityEvent) -> Result<(), String> {
    let mut event = event.clone();
    if event.at_ms.is_none() {
        event.at_ms = Some(now_ms());
    }
    store_diff(data_folder, &mut event)?;
    if event.session.is_empty() {
        // No session, no session log. Kept rather than dropped.
        return append_legacy(data_folder, &event);
    }
    let (kind, id) = envelope_identity(&event);
    event_log::append(
        data_folder,
        NewEvent {
            id,
            session: event.session.clone(),
            run: event.run.clone(),
            invocation: event.invocation.clone(),
            kind,
            payload: payload_of(&event),
        },
    )
    .map(|_| ())
    .map_err(|e| e.message())
}

/// Store a call's diff beside the log and put its counts on the event.
fn store_diff(data_folder: &Path, event: &mut ToolActivityEvent) -> Result<(), String> {
    // The diff is stored beside the log, never in it. Counted from what this
    // call produced, so the numbers are the edit's and not the tree's.
    if let Some(diff) = event.diff.take() {
        let (added, removed) = diff_counts(&diff);
        let default_path = event.resource.clone();
        let default_kind = change_kind_of(&diff);
        let change = event.change.get_or_insert_with(|| FileChange {
            path: default_path,
            kind: default_kind.into(),
            from: None,
            added: None,
            removed: None,
            diff_stored: false,
            oversized: false,
        });
        change.added.get_or_insert(added);
        change.removed.get_or_insert(removed);
        if diff.len() > MAX_DIFF_BYTES {
            change.oversized = true;
        } else if !diff.is_empty() {
            let target = diff_path(data_folder, &event.session, &event.call);
            if let Some(dir) = target.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let tmp = target.with_extension("diff.tmp");
            std::fs::write(&tmp, diff.as_bytes()).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
            change.diff_stored = true;
        }
    }
    Ok(())
}

/// Append to the legacy file. Only events with no session come here.
fn append_legacy(data_folder: &Path, event: &ToolActivityEvent) -> Result<(), String> {
    let path = log_path(data_folder);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut event = event.clone();
    event.diff = None;
    // Numbered and written under one lock, so the order of the numbers is the
    // order of the lines.
    let mut seqs = sequences().lock().unwrap_or_else(|e| e.into_inner());
    let next = match seqs.get(&path) {
        Some(n) => *n,
        None => read_legacy(data_folder).iter().filter_map(|e| e.seq).max().map_or(1, |m| m + 1),
    };
    event.seq = Some(next);
    let line = serde_json::to_string(&event).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    // Per record: a crash costs the event that was mid-write, not the run.
    file.flush().map_err(|e| e.to_string())?;
    seqs.insert(path, next + 1);
    Ok(())
}

/// The legacy file's events, in file order. A line that does not parse costs
/// that line only.
pub fn read_legacy(data_folder: &Path) -> Vec<ToolActivityEvent> {
    let Ok(file) = std::fs::File::open(log_path(data_folder)) else {
        return Vec::new();
    };
    std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// An activity event read back from its envelope, or `None` for an envelope
/// that is not one (a run or job event, a kind from a newer build).
///
/// Envelopes written before the consolidation carry a smaller camelCase
/// payload (`elapsedMs`, `exitCode`, `resourceKind`, no `v` or `at`); they
/// are read too. The envelope's session, sequence and time are the ones that
/// count.
pub fn event_from_envelope(envelope: &Envelope) -> Option<ToolActivityEvent> {
    let lifecycle = envelope.kind.starts_with("lifecycle.");
    let phase_from_kind = envelope
        .kind
        .strip_prefix("tool.")
        .or_else(|| envelope.kind.strip_prefix("lifecycle."))?;
    let Value::Object(mut map) = envelope.payload.clone() else {
        return None;
    };
    for (camel, snake) in [("elapsedMs", "elapsed_ms"), ("exitCode", "exit_code"), ("resourceKind", "kind")] {
        if let Some(v) = map.remove(camel) {
            map.entry(snake.to_string()).or_insert(v);
        }
    }
    map.entry("v".to_string()).or_insert(Value::from(1));
    map.entry("at".to_string()).or_insert_with(|| Value::from(envelope.at.clone()));
    map.entry("phase".to_string()).or_insert_with(|| Value::from(phase_from_kind));
    map.entry("tool".to_string()).or_insert_with(|| Value::from(""));
    if lifecycle {
        map.insert("event_type".to_string(), Value::from("lifecycle"));
    }
    // Only the call id is required; an envelope without one is not ours.
    map.get("call").and_then(Value::as_str).filter(|c| !c.is_empty())?;
    let mut event: ToolActivityEvent = serde_json::from_value(Value::Object(map)).ok()?;
    event.session = envelope.session.clone();
    if event.run.is_empty() {
        event.run = envelope.run.clone();
    }
    if event.invocation.is_empty() {
        event.invocation = envelope.invocation.clone();
    }
    event.seq = Some(envelope.seq);
    event.diff = None;
    Some(event)
}

/// The canonical log's activity events: one session's in log order, or every
/// session's ordered by when they were recorded. A session log that cannot be
/// read is reported and left out; it never takes the others with it.
pub fn read_canonical(data_folder: &Path, session: Option<&str>) -> Vec<ToolActivityEvent> {
    let envelopes = match session {
        Some(s) => event_log::read_session(data_folder, s).unwrap_or_else(|e| {
            eprintln!("tool activity: the event log of a session cannot be read: {}", e.message());
            Vec::new()
        }),
        None => event_log::read_all_sessions(data_folder),
    };
    let mut events: Vec<ToolActivityEvent> = envelopes.iter().filter_map(event_from_envelope).collect();
    if session.is_none() {
        events.sort_by(|a, b| {
            (a.at_ms.unwrap_or(0), &a.session, a.seq).cmp(&(b.at_ms.unwrap_or(0), &b.session, b.seq))
        });
    }
    events
}

/// Every activity event: the legacy file's first, then the canonical log's,
/// with a transition present in both counted once.
pub fn read_all(data_folder: &Path, session: Option<&str>) -> Vec<ToolActivityEvent> {
    let canonical = read_canonical(data_folder, session);
    let known: HashSet<(String, String, EventType, Phase)> = canonical
        .iter()
        .map(|e| (e.session.clone(), e.call.clone(), e.event_type, e.phase))
        .collect();
    let mut out: Vec<ToolActivityEvent> = read_legacy(data_folder)
        .into_iter()
        .filter(|e| session.map_or(true, |s| e.session == s))
        .filter(|e| !known.contains(&(e.session.clone(), e.call.clone(), e.event_type, e.phase)))
        .collect();
    out.extend(canonical);
    out
}

/// One call, folded from its events.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolActivityItem {
    /// Stable identity: the session and the call together. The provider's
    /// call id alone is not unique across sessions.
    pub id: String,
    pub call: String,
    pub tool: String,
    pub session: String,
    pub run: String,
    pub invocation: String,
    pub agent: String,
    /// The agent's durable identity, empty when the event did not carry one.
    pub agent_id: String,
    pub source: String,
    pub parent: String,
    pub supersedes: String,
    pub event_type: EventType,
    pub lifecycle: String,
    pub resource: String,
    pub summary: String,
    pub input: Option<String>,
    /// The phase the call is in now: its last event.
    pub phase: Phase,
    /// The sequence number of its first event, when it has one.
    pub seq: Option<u64>,
    /// When it was requested, which is what the timeline orders by.
    pub requested_at: String,
    pub requested_at_ms: Option<u64>,
    /// When it reached a terminal phase.
    pub finished_at: Option<String>,
    pub finished_at_ms: Option<u64>,
    pub elapsed_ms: Option<u64>,
    pub exit_code: Option<i32>,
    pub detail: String,
    /// The harness refusal's kind, when the harness declined the call.
    pub refusal: Option<String>,
    pub output: Option<String>,
    pub output_truncated: bool,
    /// `available`, `truncated`, `unavailable` (finished with nothing
    /// recorded), or `pending` (still going).
    pub output_state: String,
    pub job_id: String,
    pub task_id: String,
    pub change: Option<FileChange>,
    /// Every phase it passed through, in order.
    pub history: Vec<Phase>,
}

impl ToolActivityItem {
    fn from_first(event: ToolActivityEvent) -> Self {
        let finished = event.phase.is_terminal();
        let mut item = ToolActivityItem {
            id: item_id(&event.session, &event.call, &event.invocation),
            call: event.call,
            tool: event.tool,
            session: event.session,
            run: event.run,
            invocation: event.invocation,
            agent: event.agent,
            agent_id: event.agent_id,
            source: event.source,
            parent: event.parent,
            supersedes: event.supersedes,
            event_type: event.event_type,
            lifecycle: event.lifecycle,
            resource: event.resource,
            summary: event.summary,
            input: event.input,
            phase: event.phase,
            seq: event.seq,
            requested_at: event.at.clone(),
            requested_at_ms: event.at_ms,
            finished_at: finished.then(|| event.at.clone()),
            finished_at_ms: if finished { event.at_ms } else { None },
            elapsed_ms: event.elapsed_ms,
            exit_code: event.exit_code,
            detail: event.detail,
            refusal: event.refusal,
            output: event.output,
            output_truncated: event.output_truncated,
            output_state: String::new(),
            job_id: event.job_id,
            task_id: event.task_id,
            change: event.change,
            history: vec![event.phase],
        };
        item.output_state = output_state(&item);
        item
    }

    /// A later event refines the item; it never replaces it, and it never
    /// moves it in the list.
    fn refine(&mut self, event: ToolActivityEvent) {
        self.history.push(event.phase);
        self.phase = event.phase;
        if event.phase.is_terminal() {
            self.finished_at = Some(event.at.clone());
            self.finished_at_ms = event.at_ms;
        }
        if event.elapsed_ms.is_some() {
            self.elapsed_ms = event.elapsed_ms;
        }
        if event.exit_code.is_some() {
            self.exit_code = event.exit_code;
        }
        let mut take = |mine: &mut String, theirs: String| {
            if !theirs.is_empty() {
                *mine = theirs;
            }
        };
        take(&mut self.detail, event.detail);
        take(&mut self.resource, event.resource);
        take(&mut self.summary, event.summary);
        take(&mut self.job_id, event.job_id);
        take(&mut self.task_id, event.task_id);
        take(&mut self.parent, event.parent);
        take(&mut self.invocation, event.invocation);
        if event.input.is_some() {
            self.input = event.input;
        }
        if event.output.is_some() {
            self.output = event.output;
            self.output_truncated = event.output_truncated;
        }
        if event.change.is_some() {
            self.change = event.change;
        }
        if event.refusal.is_some() {
            self.refusal = event.refusal;
        }
        self.output_state = output_state(self);
    }
}

fn output_state(item: &ToolActivityItem) -> String {
    match (&item.output, item.phase.is_terminal()) {
        (Some(_), _) if item.output_truncated => "truncated",
        (Some(_), _) => "available",
        (None, true) => "unavailable",
        (None, false) => "pending",
    }
    .to_string()
}

pub fn item_id(session: &str, call: &str, invocation: &str) -> String {
    // The invocation is part of the identity because a provider may reuse a
    // call id across requests (AH-004): two dispatches that both called their
    // first tool `call_1` are two calls, not one call reported twice. Events
    // written before invocations were recorded have none, and fold together
    // exactly as they did.
    format!("{session}|{invocation}|{call}")
}

/// Fold the log into one durable item per call, ordered by when each call was
/// requested.
///
/// Ordering by request time and not by completion is what keeps two concurrent
/// calls in the order they were made, however their results interleave. Items
/// are keyed by session *and* call, so two sessions that reuse a provider call
/// id stay two items.
pub fn items(data_folder: &Path, session: Option<&str>) -> Vec<ToolActivityItem> {
    let events = read_all(data_folder, session);
    let mut order: Vec<String> = Vec::new();
    let mut items: HashMap<String, ToolActivityItem> = HashMap::new();

    for event in events {
        let id = item_id(&event.session, &event.call, &event.invocation);
        match items.get_mut(&id) {
            Some(item) => item.refine(event),
            None => {
                order.push(id.clone());
                items.insert(id, ToolActivityItem::from_first(event));
            }
        }
    }

    order
        .into_iter()
        .filter_map(|id| items.remove(&id))
        .collect()
}

/// Settle anything a dead run left mid-flight.
///
/// Nothing survives a restart: a shell process and a stream both died with the
/// process that owned them, so a call still `running` in the log is finished
/// in the only honest way available.
pub fn settle_unfinished(data_folder: &Path) -> usize {
    let stuck: Vec<ToolActivityItem> = items(data_folder, None)
        .into_iter()
        .filter(|i| !i.phase.is_terminal())
        .collect();
    for item in &stuck {
        let mut event = ToolActivityEvent::new(item.call.clone(), item.tool.clone(), Phase::Stale);
        event.session = item.session.clone();
        event.run = item.run.clone();
        event.agent = item.agent.clone();
        event.invocation = item.invocation.clone();
        event.event_type = item.event_type;
        event.lifecycle = item.lifecycle.clone();
        event.detail = "interrupted by application exit: the run that owned this did not survive a restart".into();
        append(data_folder, &event);
    }
    stuck.len()
}

/// Everything the audit holds about one session (or all of them), as one
/// reviewable record. AH-200.
///
/// Permission decisions and the execution record together, both already
/// redacted when they were written; nothing here re-reads a tool's full output
/// or a file. Stored diffs are named, not inlined: they are file content.
#[derive(Debug, Clone, Serialize)]
pub struct AuditExport {
    pub format: &'static str,
    pub version: u32,
    pub exported_at: String,
    pub session: Option<String>,
    pub permissions: Vec<crate::audit::PermissionRecord>,
    pub activity: Vec<ToolActivityItem>,
}

pub fn export(data_folder: &Path, session: Option<&str>) -> AuditExport {
    let q = crate::audit::Query {
        session: session.map(str::to_string),
        ..Default::default()
    };
    AuditExport {
        format: "jan-audit-export",
        version: 1,
        exported_at: now(),
        session: session.map(str::to_string),
        permissions: crate::audit::query(data_folder, &q),
        activity: items(data_folder, session),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn scratch() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "jan-activity-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn ev(call: &str, tool: &str, phase: Phase) -> ToolActivityEvent {
        let mut e = ToolActivityEvent::new(call, tool, phase);
        e.session = "s1".into();
        e.run = "r1".into();
        e
    }

    /// AH-110: the agent's identity travels with the record -- into the folded
    /// item and out through the audit export -- so provenance survives an
    /// export as well as a restart.
    #[test]
    fn the_execution_record_carries_the_agents_identity() {
        let dir = scratch();
        let mut e = ev("c1", "write", Phase::Requested);
        e.agent = "scribe".into();
        e.agent_id = "agent:scribe".into();
        append(&dir, &e);
        let mut done = ev("c1", "write", Phase::Succeeded);
        done.agent = "scribe".into();
        done.agent_id = "agent:scribe".into();
        append(&dir, &done);
        // An event from before identities were recorded keeps its name only.
        let mut legacy = ev("c2", "write", Phase::Succeeded);
        legacy.agent = "main".into();
        append(&dir, &legacy);

        let items = items(&dir, Some("s1"));
        let of = |call: &str| items.iter().find(|i| i.call == call).expect("the item").clone();
        assert_eq!(of("c1").agent_id, "agent:scribe");
        assert_eq!(of("c1").agent, "scribe");
        assert_eq!(of("c2").agent_id, "", "a legacy event invents no identity");

        let text = serde_json::to_string(&export(&dir, Some("s1"))).unwrap();
        assert!(text.contains("agent:scribe"), "the export dropped the identity: {text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AH-200 negative authority: a session's audit export carries its own
    /// permission decisions and calls only -- not a session whose id merely
    /// starts the same, not decisions recorded with no session, not another
    /// session's.
    #[test]
    fn an_audit_export_holds_only_its_own_session() {
        use crate::audit::{append as record_decision, Outcome, PermissionRecord};
        use crate::resource::Resource;
        let dir = scratch();
        let decision = |session: &str| {
            PermissionRecord::new(
                "2026-01-01T00:00:00Z".into(),
                session,
                "bash",
                "exec",
                &Resource::command(&format!("echo {session}-marker")),
                Outcome::Allow,
                "because",
            )
        };
        for session in ["s1", "s10", "", "s2"] {
            record_decision(&dir, &decision(session));
            let mut e = ev(&format!("call-{session}"), "bash", Phase::Requested);
            e.session = session.into();
            append(&dir, &e);
        }
        let out = export(&dir, Some("s1"));
        assert_eq!(out.permissions.len(), 1, "{:?}", out.permissions);
        assert_eq!(out.permissions[0].session, "s1");
        assert_eq!(out.activity.len(), 1, "{:?}", out.activity);
        assert_eq!(out.activity[0].session, "s1");
        let text = serde_json::to_string(&out).unwrap();
        for leaked in ["s10-marker", "s2-marker", "call-s10", "call-s2", "echo -marker"] {
            assert!(!text.contains(leaked), "{leaked} reached s1's audit export");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_call_stays_one_item_through_its_whole_life() {
        let dir = scratch();
        for phase in [Phase::Requested, Phase::Running, Phase::Succeeded] {
            append(&dir, &ev("c1", "read", phase));
        }
        let items = items(&dir, None);
        // The result refines the item; it does not append a second one.
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].phase, Phase::Succeeded);
        assert_eq!(
            items[0].history,
            vec![Phase::Requested, Phase::Running, Phase::Succeeded]
        );
    }

    #[test]
    fn concurrent_calls_keep_the_order_they_were_requested_in() {
        let dir = scratch();
        append(&dir, &ev("c1", "read", Phase::Requested));
        append(&dir, &ev("c2", "bash", Phase::Requested));
        append(&dir, &ev("c3", "edit", Phase::Requested));
        // Results arrive in a different order entirely.
        append(&dir, &ev("c2", "bash", Phase::Succeeded));
        append(&dir, &ev("c3", "edit", Phase::Failed));
        append(&dir, &ev("c1", "read", Phase::Succeeded));

        let items = items(&dir, None);
        assert_eq!(
            items.iter().map(|i| i.call.as_str()).collect::<Vec<_>>(),
            vec!["c1", "c2", "c3"]
        );
        assert_eq!(items[2].phase, Phase::Failed);
    }

    #[test]
    fn a_refusal_a_cancellation_and_a_failure_stay_distinguishable() {
        let dir = scratch();
        append(&dir, &ev("c1", "bash", Phase::Requested));
        append(&dir, &ev("c1", "bash", Phase::AwaitingPermission));
        append(&dir, &ev("c1", "bash", Phase::Refused));
        append(&dir, &ev("c2", "bash", Phase::Requested));
        append(&dir, &ev("c2", "bash", Phase::Cancelled));
        append(&dir, &ev("c3", "bash", Phase::Requested));
        append(&dir, &ev("c3", "bash", Phase::Failed));

        let items = items(&dir, None);
        assert_eq!(items[0].phase, Phase::Refused);
        assert_eq!(items[1].phase, Phase::Cancelled);
        assert_eq!(items[2].phase, Phase::Failed);
        // None of them may be hidden as "completed work".
        assert!(items.iter().all(|i| !i.phase.is_hideable()));
    }

    #[test]
    fn only_a_clean_success_may_be_hidden() {
        assert!(Phase::Succeeded.is_hideable());
        for phase in [
            Phase::Requested,
            Phase::Queued,
            Phase::AwaitingPermission,
            Phase::Allowed,
            Phase::Running,
            Phase::Refused,
            Phase::Failed,
            Phase::Cancelled,
            Phase::Stale,
            Phase::TimedOut,
        ] {
            assert!(!phase.is_hideable(), "{phase:?} must never be hidden");
        }
    }

    #[test]
    fn the_timeline_survives_a_restart() {
        let dir = scratch();
        append(&dir, &ev("c1", "read", Phase::Requested));
        append(&dir, &ev("c1", "read", Phase::Succeeded));
        // Nothing in memory; everything read back off disk.
        let restored = items(&dir, None);
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].phase, Phase::Succeeded);
        assert_eq!(restored[0].tool, "read");
    }

    #[test]
    fn a_call_left_running_by_a_dead_run_becomes_stale_not_lost() {
        let dir = scratch();
        append(&dir, &ev("c1", "bash", Phase::Requested));
        append(&dir, &ev("c1", "bash", Phase::Running));
        append(&dir, &ev("c2", "read", Phase::Requested));
        append(&dir, &ev("c2", "read", Phase::Succeeded));

        assert_eq!(settle_unfinished(&dir), 1);
        let items = items(&dir, None);
        assert_eq!(items[0].phase, Phase::Stale);
        assert!(items[0].detail.contains("interrupted by application exit"));
        // The finished one is untouched.
        assert_eq!(items[1].phase, Phase::Succeeded);
        // And settling twice does not invent more work.
        assert_eq!(settle_unfinished(&dir), 0);
    }

    #[test]
    fn one_session_cannot_read_another_sessions_activity() {
        let dir = scratch();
        append(&dir, &ev("c1", "read", Phase::Requested));
        let mut other = ToolActivityEvent::new("c9", "read", Phase::Requested);
        other.session = "s2".into();
        append(&dir, &other);

        let mine = items(&dir, Some("s1"));
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].call, "c1");
    }

    #[test]
    fn a_truncated_tail_costs_one_event_not_the_file() {
        let dir = scratch();
        append(&dir, &ev("c1", "read", Phase::Requested));
        append(&dir, &ev("c1", "read", Phase::Succeeded));
        let path = event_log::log_path(&dir, "s1");
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"v\":1,\"id\":\"tool:c2:requ");
        std::fs::write(&path, raw).unwrap();

        let items = items(&dir, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].phase, Phase::Succeeded);
    }

    /// The one store: a transition lands in the session's canonical log, as
    /// one envelope of the tool's kind, and nowhere else.
    #[test]
    fn a_transition_is_one_envelope_in_the_session_log_and_nothing_else() {
        let dir = scratch();
        append(&dir, &ev("c1", "bash", Phase::Requested));
        append(&dir, &ev("c1", "bash", Phase::Succeeded));
        // A retried record of the same transition is the same event.
        append(&dir, &ev("c1", "bash", Phase::Succeeded));
        let envelopes = event_log::read_session(&dir, "s1").unwrap();
        assert_eq!(
            envelopes.iter().map(|e| (e.kind.as_str(), e.id.as_str())).collect::<Vec<_>>(),
            [("tool.requested", "tool:r1:::c1:requested"), ("tool.succeeded", "tool:r1:::c1:succeeded")]
        );
        assert!(!log_path(&dir).exists(), "nothing is written to the legacy file");
        assert_eq!(items(&dir, Some("s1"))[0].history, [Phase::Requested, Phase::Succeeded]);
    }

    /// A provider numbers its calls from zero in every response, and two
    /// subagents share their parent's session: the same call id in another
    /// run, agent or request is another call, and neither is dropped as a
    /// repeat of the other.
    #[test]
    fn a_reused_provider_call_id_is_not_taken_for_a_repeat() {
        let dir = scratch();
        let mut explorer = ev("call_0", "ls", Phase::Succeeded);
        explorer.agent = "explorer".into();
        let mut reviewer = ev("call_0", "read", Phase::Succeeded);
        reviewer.agent = "reviewer".into();
        let mut next_run = ev("call_0", "grep", Phase::Succeeded);
        next_run.run = "r2".into();
        let mut next_request = ev("call_0", "find", Phase::Succeeded);
        next_request.invocation = "inv-2".into();
        for e in [&explorer, &reviewer, &next_run, &next_request] {
            append(&dir, e);
        }
        // A retried record of one of them is still one event.
        append(&dir, &explorer);
        let tools: Vec<String> = event_log::read_session(&dir, "s1")
            .unwrap()
            .into_iter()
            .map(|e| e.payload["tool"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(tools, ["ls", "read", "grep", "find"]);
    }

    /// Older builds wrote every transition to both stores. Loading them counts
    /// each transition once, and a call an older build left in the legacy file
    /// alone still reads.
    #[test]
    fn a_transition_recorded_in_both_stores_by_an_older_build_counts_once() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("audit")).unwrap();
        std::fs::write(
            log_path(&dir),
            concat!(
                "{\"v\":1,\"at\":\"2026-09-01T00:00:00Z\",\"session\":\"s1\",\"call\":\"c1\",\"tool\":\"read\",\"phase\":\"requested\",\"detail\":\"\"}\n",
                "{\"v\":1,\"at\":\"2026-09-01T00:00:01Z\",\"session\":\"s1\",\"call\":\"c1\",\"tool\":\"read\",\"phase\":\"succeeded\",\"detail\":\"\"}\n",
                "{\"v\":2,\"at\":\"2026-09-01T00:00:02Z\",\"seq\":3,\"session\":\"s1\",\"call\":\"only-legacy\",\"tool\":\"ls\",\"phase\":\"succeeded\",\"detail\":\"\"}\n",
            ),
        )
        .unwrap();
        // The envelopes the older build wrote beside them: its smaller payload.
        for phase in ["requested", "succeeded"] {
            event_log::append(
                &dir,
                NewEvent {
                    id: format!("tool:c1:{phase}"),
                    session: "s1".into(),
                    run: "r1".into(),
                    invocation: String::new(),
                    kind: format!("tool.{phase}"),
                    payload: serde_json::json!({ "tool": "read", "phase": phase, "call": "c1", "elapsedMs": 5, "resourceKind": "path" }),
                },
            )
            .unwrap();
        }
        let items = items(&dir, Some("s1"));
        assert_eq!(items.len(), 2);
        let c1 = items.iter().find(|i| i.call == "c1").unwrap();
        assert_eq!(c1.history, [Phase::Requested, Phase::Succeeded], "each transition once");
        assert_eq!(c1.elapsed_ms, Some(5));
        assert!(items.iter().any(|i| i.call == "only-legacy" && i.phase == Phase::Succeeded));
    }

    /// Settling after a restart writes the ending into the canonical log, so
    /// the timeline and the export agree on how the call ended.
    #[test]
    fn a_settled_call_ends_in_the_canonical_log() {
        let dir = scratch();
        append(&dir, &ev("c1", "bash", Phase::Requested));
        append(&dir, &ev("c1", "bash", Phase::Running));
        event_log::forget_loaded();
        assert_eq!(settle_unfinished(&dir), 1);
        let kinds: Vec<String> = event_log::read_session(&dir, "s1").unwrap().into_iter().map(|e| e.kind).collect();
        assert_eq!(kinds, ["tool.requested", "tool.running", "tool.stale"]);
        assert_eq!(settle_unfinished(&dir), 0);
    }

    /// An event with no session has no session log; it is kept in the legacy
    /// file rather than dropped, and still reads.
    #[test]
    fn an_event_with_no_session_is_kept() {
        let dir = scratch();
        let mut e = ToolActivityEvent::new("u1", "read", Phase::Succeeded);
        e.session = String::new();
        append(&dir, &e);
        assert_eq!(read_legacy(&dir).len(), 1);
        assert_eq!(items(&dir, None).len(), 1);
    }

    /// A new file is recorded as created and a removed one as deleted, from
    /// the diff's own headers; a caller's own kind is kept.
    #[test]
    fn a_change_says_whether_it_created_edited_or_deleted_the_file() {
        assert_eq!(change_kind_of("--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n"), "created");
        assert_eq!(change_kind_of("@@ -0,0 +1 @@\n+a\n"), "created");
        assert_eq!(change_kind_of("--- a/a.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n"), "deleted");
        assert_eq!(change_kind_of("@@ -1,2 +1,2 @@\n-a\n+b\n c\n"), "edited");
        let dir = scratch();
        let mut made = ev("w1", "write", Phase::Succeeded);
        made.diff = Some("@@ -0,0 +1,2 @@\n+a\n+b\n".into());
        append(&dir, &made);
        let mut given = ev("w2", "write", Phase::Succeeded);
        given.diff = Some("@@ -0,0 +1 @@\n+a\n".into());
        given.change = Some(FileChange {
            path: "x".into(),
            kind: "renamed".into(),
            from: Some("y".into()),
            added: None,
            removed: None,
            diff_stored: false,
            oversized: false,
        });
        append(&dir, &given);
        let items = items(&dir, Some("s1"));
        assert_eq!(items[0].change.as_ref().unwrap().kind, "created");
        assert_eq!(items[1].change.as_ref().unwrap().kind, "renamed");
    }

    /// A harness refusal keeps its kind through the log and onto the item,
    /// and a metadata-only reader can still see it.
    #[test]
    fn a_harness_refusal_keeps_its_kind() {
        let dir = scratch();
        let mut asked = ev("call_0", "write", Phase::Requested);
        asked.agent = "reviewer".into();
        let mut refused = ev("call_0", "write", Phase::Refused);
        refused.agent = "reviewer".into();
        refused.detail = "not a valid call".into();
        refused.refusal = Some("tool-not-offered".into());
        append(&dir, &asked);
        append(&dir, &refused);
        let item = &items(&dir, Some("s1"))[0];
        assert_eq!(item.phase, Phase::Refused);
        assert_eq!(item.refusal.as_deref(), Some("tool-not-offered"));
        assert!(crate::event_export::METADATA_FIELDS.contains(&"refusal"));
    }

    /// A lifecycle event is its own kind in the log, and reads back as one.
    #[test]
    fn a_lifecycle_event_keeps_its_kind_in_the_log() {
        let dir = scratch();
        let mut steer = ev("steer-1", "steering", Phase::Succeeded);
        steer.event_type = EventType::Lifecycle;
        steer.lifecycle = "steering".into();
        append(&dir, &steer);
        let envelope = &event_log::read_session(&dir, "s1").unwrap()[0];
        assert_eq!(envelope.kind, "lifecycle.succeeded");
        assert_eq!(envelope.id, "life:steer-1:succeeded");
        assert_eq!(items(&dir, Some("s1"))[0].event_type, EventType::Lifecycle);
    }

    /// A payload too large for an envelope is cut down, not replaced by the
    /// log's "too large" note, so the transition still reads.
    #[test]
    fn an_oversized_transition_still_reads() {
        let dir = scratch();
        let mut done = ev("big-detail", "bash", Phase::Failed);
        done.detail = "d".repeat(event_log::MAX_PAYLOAD_BYTES);
        done.output = Some("o".repeat(MAX_OUTPUT_BYTES));
        append(&dir, &done);
        let item = &items(&dir, Some("s1"))[0];
        assert_eq!(item.phase, Phase::Failed);
        assert!(item.detail.len() < event_log::MAX_PAYLOAD_BYTES);
        assert!(item.output_truncated);
    }

    #[test]
    fn a_credential_never_reaches_the_file() {
        let dir = scratch();
        let mut e = ev("c1", "bash", Phase::Failed);
        e.summary = "curl -H 'Authorization: Bearer sk-not-a-real-key' https://x".into();
        e.detail = "failed with token sk-not-a-real-key".into();
        e.input = Some("{\"command\":\"PGPASSWORD=hunter2 psql\"}".into());
        e.output = Some("using token=sk-not-a-real-key\n[exit 1]".into());
        e.diff = Some("+API_KEY=sk-not-a-real-key\n".into());
        append(&dir, &e.redacted());

        let raw = std::fs::read_to_string(event_log::log_path(&dir, "s1")).unwrap();
        assert!(!raw.contains("sk-not-a-real-key"), "{raw}");
        assert!(!raw.contains("hunter2"), "{raw}");
        let diff = read_diff(&dir, "s1", "c1").unwrap();
        assert!(!diff.contains("sk-not-a-real-key"), "{diff}");
    }

    #[test]
    fn every_event_is_numbered_in_the_order_it_was_written() {
        let dir = scratch();
        for call in ["a", "b", "c"] {
            append(&dir, &ev(call, "read", Phase::Requested));
        }
        let seqs: Vec<u64> = read_all(&dir, Some("s1")).iter().filter_map(|e| e.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
        // A new process continues from what is on disk rather than restarting.
        event_log::forget_loaded();
        append(&dir, &ev("d", "read", Phase::Requested));
        assert_eq!(read_all(&dir, Some("s1")).last().unwrap().seq, Some(4));
        let items = items(&dir, None);
        assert_eq!(items.iter().map(|i| i.seq).collect::<Vec<_>>(), vec![Some(1), Some(2), Some(3), Some(4)]);
    }

    #[test]
    fn a_version_one_line_still_reads() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("audit")).unwrap();
        std::fs::write(
            log_path(&dir),
            "{\"v\":1,\"at\":\"2026-09-01T00:00:00Z\",\"session\":\"s1\",\"call\":\"old\",\"tool\":\"read\",\"phase\":\"succeeded\",\"detail\":\"\"}\n",
        )
        .unwrap();
        let items = items(&dir, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].seq, None);
        assert_eq!(items[0].event_type, EventType::Tool);
        // No output was recorded: that is "unavailable", not an empty success.
        assert_eq!(items[0].output_state, "unavailable");
    }

    #[test]
    fn two_sessions_reusing_a_call_id_stay_two_items() {
        let dir = scratch();
        append(&dir, &ev("call_0", "read", Phase::Requested));
        let mut other = ev("call_0", "bash", Phase::Requested);
        other.session = "s2".into();
        append(&dir, &other);
        append(&dir, &ev("call_0", "read", Phase::Succeeded));
        let all = items(&dir, None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].phase, Phase::Succeeded);
        assert_eq!(all[1].phase, Phase::Requested);
        assert_ne!(all[0].id, all[1].id);
    }

    #[test]
    fn an_edit_keeps_its_own_diff_and_counts() {
        let dir = scratch();
        append(&dir, &ev("e1", "edit", Phase::Requested));
        let mut done = ev("e1", "edit", Phase::Succeeded);
        done.resource = "src/lib.rs".into();
        done.diff = Some("--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n keep\n".into());
        append(&dir, &done.redacted());

        let item = &items(&dir, None)[0];
        let change = item.change.as_ref().unwrap();
        assert_eq!((change.added, change.removed), (Some(2), Some(1)));
        assert!(change.diff_stored && !change.oversized);
        assert_eq!(change.path, "src/lib.rs");
        assert!(read_diff(&dir, "s1", "e1").unwrap().contains("+more"));
        // The diff lives beside the log, not in it.
        assert!(!std::fs::read_to_string(event_log::log_path(&dir, "s1")).unwrap().contains("+more"));
    }

    #[test]
    fn an_oversized_diff_is_counted_but_not_kept() {
        let dir = scratch();
        let mut done = ev("big", "write", Phase::Succeeded);
        done.change = Some(FileChange {
            path: "dump.json".into(),
            kind: "created".into(),
            from: None,
            added: None,
            removed: None,
            diff_stored: false,
            oversized: false,
        });
        done.diff = Some(format!("+{}\n", "x".repeat(MAX_DIFF_BYTES + 10)));
        append(&dir, &done);
        let change = items(&dir, None)[0].change.clone().unwrap();
        assert!(change.oversized && !change.diff_stored);
        assert_eq!(change.kind, "created");
        assert_eq!(change.added, Some(1));
        assert!(read_diff(&dir, "s1", "big").is_none());
    }

    #[test]
    fn a_diff_path_cannot_leave_the_audit_folder() {
        let dir = scratch();
        let p = diff_path(&dir, "..\\..\\evil", "../../../x");
        assert!(p.starts_with(dir.join("audit").join("diffs")));
        assert!(!p.to_string_lossy().contains(".."));
    }

    #[test]
    fn output_is_bounded_to_its_end_and_input_to_its_start() {
        let dir = scratch();
        let mut done = ev("o1", "bash", Phase::Succeeded);
        done.input = Some(format!("{{\"command\":\"{}\"}}", "y".repeat(MAX_INPUT_BYTES * 2)));
        done.output = Some(format!("{}\nFAILED at the end\n[exit 1]", "z".repeat(MAX_OUTPUT_BYTES * 2)));
        append(&dir, &done.redacted());
        let item = &items(&dir, None)[0];
        let out = item.output.as_deref().unwrap();
        assert!(out.len() <= MAX_OUTPUT_BYTES);
        assert!(out.ends_with("FAILED at the end\n[exit 1]"));
        assert!(item.output_truncated);
        assert_eq!(item.output_state, "truncated");
        assert!(item.input.as_deref().unwrap().len() <= MAX_INPUT_BYTES + 3);
    }

    #[test]
    fn lifecycle_events_share_the_one_sequence() {
        let dir = scratch();
        append(&dir, &ev("c1", "read", Phase::Requested));
        let mut compacted = ev("compaction-1", "compaction", Phase::Succeeded);
        compacted.event_type = EventType::Lifecycle;
        compacted.lifecycle = "compaction".into();
        append(&dir, &compacted);
        append(&dir, &ev("c2", "read", Phase::Requested));
        let items = items(&dir, None);
        assert_eq!(items[1].event_type, EventType::Lifecycle);
        assert_eq!(items[1].lifecycle, "compaction");
        assert!(items[0].seq < items[1].seq && items[1].seq < items[2].seq);
    }

    #[test]
    fn the_export_joins_decisions_and_activity_for_one_session_only() {
        let dir = scratch();
        append(&dir, &ev("c1", "bash", Phase::Requested));
        let mut other = ev("c2", "bash", Phase::Requested);
        other.session = "s2".into();
        append(&dir, &other);
        crate::audit::append(
            &dir,
            &crate::audit::PermissionRecord::new(
                now(),
                "s1",
                "bash",
                "exec",
                &crate::resource::Resource::command("ls"),
                crate::audit::Outcome::Granted,
                "asked",
            ),
        );
        let out = export(&dir, Some("s1"));
        assert_eq!(out.activity.len(), 1);
        assert_eq!(out.permissions.len(), 1);
        assert!(out.activity.iter().all(|i| i.session == "s1"));
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("jan-audit-export"));
    }

    /// Steering is one more lifecycle name, not a schema of its own: a branch
    /// that records steering needs no second store and no schema change.
    #[test]
    fn steering_is_an_optional_lifecycle_event_in_the_same_sequence() {
        let dir = scratch();
        append(&dir, &ev("c1", "read", Phase::Requested));
        let mut steer = ev("steer-1", "steering", Phase::Succeeded);
        steer.event_type = EventType::Lifecycle;
        steer.lifecycle = "steering".into();
        steer.summary = "the user redirected the run".into();
        append(&dir, &steer);
        let items = items(&dir, Some("s1"));
        assert_eq!(items[1].lifecycle, "steering");
        assert!(items[0].seq < items[1].seq);
    }

    /// A later build can add fields -- a prompt snapshot id, token usage --
    /// and this build still reads the line. The invocation id is the join key
    /// to a snapshot, so nothing about snapshots needs to live here.
    #[test]
    fn lines_with_fields_from_a_later_build_still_read() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("audit")).unwrap();
        std::fs::write(
            log_path(&dir),
            "{\"v\":3,\"at\":\"2026-10-01T00:00:00Z\",\"seq\":7,\"session\":\"s1\",\"call\":\"c1\",\"invocation\":\"inv-1\",\"tool\":\"read\",\"phase\":\"succeeded\",\"detail\":\"\",\"snapshot_id\":\"snap-9\",\"usage\":{\"prompt_tokens\":12}}\n",
        )
        .unwrap();
        let items = items(&dir, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].invocation, "inv-1");
        assert_eq!(items[0].seq, Some(7));
        // And an unscoped event continues the legacy file's sequence after it.
        sequences().lock().unwrap().remove(&log_path(&dir));
        let mut unscoped = ev("c2", "read", Phase::Requested);
        unscoped.session = String::new();
        append(&dir, &unscoped);
        assert_eq!(read_legacy(&dir).last().unwrap().seq, Some(8));
    }

    /// In the legacy file, a damaged line in the middle costs that line only;
    /// everything after it still reads, in order.
    #[test]
    fn a_damaged_legacy_line_in_the_middle_costs_that_line_only() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("audit")).unwrap();
        std::fs::write(
            log_path(&dir),
            concat!(
                "{\"v\":2,\"at\":\"2026-09-01T00:00:00Z\",\"seq\":1,\"session\":\"s1\",\"call\":\"c1\",\"tool\":\"read\",\"phase\":\"requested\",\"detail\":\"\"}\n",
                "not json at all\n{\"v\":2,\"call\":\n",
                "{\"v\":2,\"at\":\"2026-09-01T00:00:01Z\",\"seq\":2,\"session\":\"s1\",\"call\":\"c1\",\"tool\":\"read\",\"phase\":\"succeeded\",\"detail\":\"\"}\n",
                "{\"v\":2,\"at\":\"2026-09-01T00:00:02Z\",\"seq\":3,\"session\":\"s1\",\"call\":\"c2\",\"tool\":\"read\",\"phase\":\"requested\",\"detail\":\"\"}\n",
            ),
        )
        .unwrap();
        let items = items(&dir, None);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].phase, Phase::Succeeded);
    }

    /// Stopped by someone and cut off by an exit are different endings, and
    /// neither is "succeeded" with no output.
    #[test]
    fn cancelled_and_interrupted_stay_apart_and_neither_claims_output() {
        let dir = scratch();
        append(&dir, &ev("stop", "bash", Phase::Requested));
        append(&dir, &ev("stop", "bash", Phase::Cancelled));
        append(&dir, &ev("cut", "bash", Phase::Requested));
        append(&dir, &ev("cut", "bash", Phase::Running));
        settle_unfinished(&dir);
        let items = items(&dir, None);
        assert_eq!(items[0].phase, Phase::Cancelled);
        assert_eq!(items[1].phase, Phase::Stale);
        assert!(items.iter().all(|i| i.output_state == "unavailable"));
        assert!(items.iter().all(|i| i.finished_at.is_some()));
    }

    /// Ids are stable: the same session and call always name the same item,
    /// before and after a restart.
    #[test]
    fn an_item_id_is_its_session_invocation_and_call() {
        let dir = scratch();
        append(&dir, &ev("c1", "read", Phase::Requested));
        let first = items(&dir, None)[0].id.clone();
        event_log::forget_loaded();
        append(&dir, &ev("c1", "read", Phase::Succeeded));
        assert_eq!(items(&dir, None)[0].id, first);
        assert_eq!(first, "s1||c1", "an event with no invocation keeps folding as it did");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AH-004: a provider that numbers its tool calls per request will reuse
    /// `call_1`. Two dispatches are two calls, whatever they were called.
    #[test]
    fn one_call_id_reused_by_two_invocations_stays_two_items() {
        let dir = scratch();
        let mut first = ev("call_1", "read", Phase::Requested);
        first.invocation = "inv-1".into();
        append(&dir, &first);
        let mut first_done = ev("call_1", "read", Phase::Succeeded);
        first_done.invocation = "inv-1".into();
        first_done.output = Some("the first file".into());
        append(&dir, &first_done);
        let mut second = ev("call_1", "read", Phase::Requested);
        second.invocation = "inv-2".into();
        append(&dir, &second);

        let found = items(&dir, Some("s1"));
        assert_eq!(found.len(), 2, "{found:?}");
        let by = |inv: &str| found.iter().find(|i| i.invocation == inv).expect("the item");
        assert_eq!(by("inv-1").phase, Phase::Succeeded);
        assert_eq!(by("inv-1").output.as_deref(), Some("the first file"));
        assert_eq!(by("inv-2").phase, Phase::Requested, "the second call is still running");
        assert!(by("inv-2").output.is_none(), "the first call's output leaked into the second");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
