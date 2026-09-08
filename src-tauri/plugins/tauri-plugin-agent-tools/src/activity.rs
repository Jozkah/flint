//! What every tool execution did, recorded as it happens. AH-050.
//!
//! `audit.rs` records permission *decisions*; this records the *lifecycle* of
//! the call itself, so a completed run can be replayed without the transcript
//! and without the model's own account of what it did. One call is one item
//! that moves through phases -- it is never replaced by its result, and a
//! result arriving out of order does not reorder anything, because ordering
//! comes from when the call was requested.
//!
//! Append-only JSONL, flushed per record, with a reader that drops an
//! unparseable line so a truncated tail costs one event rather than the file.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::audit::{now, redact};

pub const SCHEMA_VERSION: u32 = 1;

/// Where a call has got to.
///
/// Deliberately not collapsed into "done": a refusal, a cancellation and a
/// failure are different things to have happened, and a timeline that shows
/// them alike cannot answer "what went wrong" or "what did I not allow".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// The model asked for the call. Always the first event of an item.
    Requested,
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

/// One lifecycle event of one tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolActivityEvent {
    #[serde(rename = "v")]
    pub version: u32,
    /// RFC 3339, UTC.
    pub at: String,

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
    #[serde(default)]
    pub project: String,

    // -- what was asked ----------------------------------------------------
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
            session: String::new(),
            run: String::new(),
            call: call.into(),
            invocation: String::new(),
            agent: String::new(),
            project: String::new(),
            tool: tool.into(),
            capability: String::new(),
            kind: String::new(),
            resource: String::new(),
            summary: String::new(),
            phase,
            elapsed_ms: None,
            exit_code: None,
            detail: String::new(),
        }
    }

    pub fn redacted(mut self) -> Self {
        self.resource = redact(&self.resource);
        self.summary = redact(&self.summary);
        self.detail = redact(&self.detail);
        self
    }
}

pub fn log_path(data_folder: &Path) -> PathBuf {
    data_folder.join("audit").join("tool-activity.jsonl")
}

/// Record one event. A failure to write is reported, never swallowed into a
/// silent gap in the record.
pub fn append(data_folder: &Path, event: &ToolActivityEvent) {
    if let Err(e) = try_append(data_folder, event) {
        eprintln!("tool activity: could not record {:?}: {e}", event.phase);
    }
}

fn try_append(data_folder: &Path, event: &ToolActivityEvent) -> Result<(), String> {
    let path = log_path(data_folder);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(event).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    // Per record: a crash costs the event that was mid-write, not the run.
    file.flush().map_err(|e| e.to_string())
}

pub fn read_all(data_folder: &Path) -> Vec<ToolActivityEvent> {
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

/// One call, folded from its events.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolActivityItem {
    pub call: String,
    pub tool: String,
    pub session: String,
    pub run: String,
    pub invocation: String,
    pub agent: String,
    pub resource: String,
    pub summary: String,
    /// The phase the call is in now: its last event.
    pub phase: Phase,
    /// When it was requested, which is what the timeline orders by.
    pub requested_at: String,
    pub elapsed_ms: Option<u64>,
    pub exit_code: Option<i32>,
    pub detail: String,
    /// Every phase it passed through, in order.
    pub history: Vec<Phase>,
}

/// Fold the log into one durable item per call, ordered by when each call was
/// requested.
///
/// Ordering by request time and not by completion is what keeps two concurrent
/// calls in the order they were made, however their results interleave.
pub fn items(data_folder: &Path, session: Option<&str>) -> Vec<ToolActivityItem> {
    let events = read_all(data_folder);
    let mut order: Vec<String> = Vec::new();
    let mut items: std::collections::HashMap<String, ToolActivityItem> =
        std::collections::HashMap::new();

    for event in events {
        if let Some(want) = session {
            if event.session != want {
                continue;
            }
        }
        match items.get_mut(&event.call) {
            Some(item) => {
                // A later event refines the item; it never replaces it, and it
                // never moves it in the list.
                item.history.push(event.phase);
                item.phase = event.phase;
                if event.elapsed_ms.is_some() {
                    item.elapsed_ms = event.elapsed_ms;
                }
                if event.exit_code.is_some() {
                    item.exit_code = event.exit_code;
                }
                if !event.detail.is_empty() {
                    item.detail = event.detail;
                }
                if !event.resource.is_empty() {
                    item.resource = event.resource;
                }
                if !event.summary.is_empty() {
                    item.summary = event.summary;
                }
            }
            None => {
                order.push(event.call.clone());
                items.insert(
                    event.call.clone(),
                    ToolActivityItem {
                        call: event.call,
                        tool: event.tool,
                        session: event.session,
                        run: event.run,
                        invocation: event.invocation,
                        agent: event.agent,
                        resource: event.resource,
                        summary: event.summary,
                        phase: event.phase,
                        requested_at: event.at,
                        elapsed_ms: event.elapsed_ms,
                        exit_code: event.exit_code,
                        detail: event.detail,
                        history: vec![event.phase],
                    },
                );
            }
        }
    }

    order
        .into_iter()
        .filter_map(|call| items.remove(&call))
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
        event.detail = "the run that owned this call did not survive a restart".into();
        append(data_folder, &event);
    }
    stuck.len()
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
        let path = log_path(&dir);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"v\":1,\"at\":\"2026-");
        std::fs::write(&path, raw).unwrap();

        let items = items(&dir, None);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].phase, Phase::Succeeded);
    }

    #[test]
    fn a_credential_never_reaches_the_file() {
        let dir = scratch();
        let mut e = ev("c1", "bash", Phase::Failed);
        e.summary = "curl -H 'Authorization: Bearer sk-not-a-real-key' https://x".into();
        e.detail = "failed with token sk-not-a-real-key".into();
        append(&dir, &e.redacted());

        let raw = std::fs::read_to_string(log_path(&dir)).unwrap();
        assert!(!raw.contains("sk-not-a-real-key"), "{raw}");
    }
}
