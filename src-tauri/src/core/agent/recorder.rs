//! Durable record of what a run did (AHD-002, AHD-003, AHD-010).
//!
//! Before this module a run left nothing behind that could be replayed or
//! audited. `StreamEvent` is a UI stream that was never persisted, the CLI's
//! `display.jsonl` is a rendering journal whose own header calls permission
//! prompts transient by design, and the three identifiers a run carried --
//! `thread_id`, `session_id`, and a subagent-local `run_id` -- were minted
//! independently and joined to nothing.
//!
//! [`RunRecorder`] is the one place a run's canonical events reach disk. It
//! holds the run's [`RunIdentity`], appends [`EventPayload`]s to a versioned
//! JSONL log, and keeps a [`RunRecord`] alongside it so a later process can
//! tell a run that never closed from one that failed.
//!
//! Two rules govern everything here:
//!
//! 1. **Recording never fails a run.** A full disk must not turn a working
//!    agent into a broken one. Failures are counted, not propagated -- but they
//!    are counted, and the count is reported, because an audit log that
//!    silently lost entries is worse than one that admits it did.
//! 2. **No raw tool arguments reach disk.** Arguments carry file contents,
//!    credentials and command lines. Only a redacted, truncated resource
//!    descriptor and an unkeyed fingerprint are recorded.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use jan_agent_harness::envelope::EventLog;
use jan_agent_harness::error::HarnessError;
use jan_agent_harness::event::{fingerprint, EventPayload, HarnessEvent};
use jan_agent_harness::identity::{RunIdentity, SessionId, ThreadId};
use jan_agent_harness::state::{RunRecord, RunStatus, StateStore};

/// Longest resource descriptor written to an event.
///
/// A shell command can be a whole script; a path can be pathological. The log
/// is append-only and exported, so an unbounded field is an unbounded file.
const MAX_RESOURCE_LEN: usize = 256;

/// Directory under the Jan data folder holding per-run state.
///
/// Deliberately not `agent/`, which already holds agent *configuration*
/// (subagent definitions, skills). Run state is machine-written and disposable;
/// mixing it into a directory a user edits by hand invites both to be lost.
pub(crate) const STATE_DIR: &str = "agent-state";

/// The append-only state one run shares across every agent in it.
///
/// Split from [`RunRecorder`] so a subagent can record into the same log under
/// its own agent identity: one run, one file, correct provenance per event.
struct RunLog {
    store: StateStore,
    log: Mutex<EventLog>,
    record: Mutex<RunRecord>,
    seq: AtomicU64,
    /// Events that could not be written. Reported rather than swallowed.
    dropped: AtomicU64,
}

/// Records one agent's canonical events into its run's durable log.
pub(crate) struct RunRecorder {
    identity: RunIdentity,
    shared: std::sync::Arc<RunLog>,
}

impl RunRecorder {
    /// Opens a recorder for a new run under `<jan_data>/agent-runs/<run_id>/`.
    ///
    /// `thread` and `session` are adopted when they are already harness ids and
    /// minted otherwise, so a surface that has its own identifiers keeps them
    /// and one that does not still gets a correlated run.
    pub(crate) fn open(
        jan_data_folder: &Path,
        thread: Option<&str>,
        session: Option<&str>,
        model: &str,
        plan_mode: bool,
    ) -> Result<Self, HarnessError> {
        let store = StateStore::new(jan_data_folder.join(STATE_DIR));
        let thread = thread
            .and_then(|raw| ThreadId::parse(raw).ok())
            .unwrap_or_default();
        let session = session
            .and_then(|raw| SessionId::parse(raw).ok())
            .unwrap_or_default();
        let identity = RunIdentity::root(thread, session);

        let record = RunRecord::started(identity.clone(), model, plan_mode);
        store.save(&record)?;
        let log = EventLog::open(store.events_path(&identity.run))?;

        Ok(Self {
            identity,
            shared: std::sync::Arc::new(RunLog {
                store,
                log: Mutex::new(log),
                record: Mutex::new(record),
                seq: AtomicU64::new(0),
                dropped: AtomicU64::new(0),
            }),
        })
    }

    /// A recorder for a subagent of this run.
    ///
    /// Shares the run's log, record and sequence, so a child's tool calls land
    /// in the same audit trail as its parent's and in the true order they
    /// happened -- but under a fresh agent id naming the child, so a reader can
    /// tell which agent did what (`AH-110`).
    pub(crate) fn child(&self) -> Self {
        Self {
            identity: self.identity.child(),
            shared: self.shared.clone(),
        }
    }

    pub(crate) fn identity(&self) -> &RunIdentity {
        &self.identity
    }

    /// Where this run's record and event log live.
    pub(crate) fn run_dir(&self) -> std::path::PathBuf {
        self.shared.store.run_dir(&self.identity.run)
    }

    /// Appends one event.
    ///
    /// Deliberately infallible and synchronous: it is called from the tool
    /// dispatcher, which holds no lock across an await, and a recording failure
    /// must not become a run failure.
    pub(crate) fn emit(&self, payload: EventPayload) {
        let seq = self.shared.seq.fetch_add(1, Ordering::Relaxed);
        let event = HarnessEvent::new(seq, self.identity.clone(), payload);

        let written = match self.shared.log.lock() {
            Ok(mut log) => log.append(&event).is_ok(),
            // A poisoned lock means another thread panicked mid-append. The log
            // may be torn; the reader tolerates a torn final line, so the run
            // continues and this event is counted as lost.
            Err(_) => false,
        };
        if written {
            if let Ok(mut record) = self.shared.record.lock() {
                record.last_event_seq = seq;
            }
        } else {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            log::warn!(
                "agent run {}: could not record event {} ({} lost so far)",
                self.identity.run,
                event.kind(),
                self.shared.dropped.load(Ordering::Relaxed)
            );
        }
    }

    /// Writes the run record to disk, capturing progress so far.
    ///
    /// Called at turn boundaries rather than per event: the event log is the
    /// source of truth for what happened, and the record only has to be recent
    /// enough for resume to find its place.
    pub(crate) fn persist(&self) {
        let snapshot = match self.shared.record.lock() {
            Ok(record) => record.clone(),
            Err(_) => return,
        };
        if let Err(error) = self.shared.store.save(&snapshot) {
            log::warn!(
                "agent run {}: could not persist run record: {error}",
                self.identity.run
            );
        }
    }

    /// Closes the run in a terminal state and flushes the record.
    pub(crate) fn finish(&self, status: RunStatus) {
        if let Ok(mut record) = self.shared.record.lock() {
            record.finish(status);
        }
        self.persist();
    }

    /// How many events could not be written. Zero on a healthy run.
    pub(crate) fn dropped_events(&self) -> u64 {
        self.shared.dropped.load(Ordering::Relaxed)
    }
}

/// The redacted resource descriptor for a tool call.
///
/// Returns the path a filesystem tool touches or the command a shell tool runs,
/// truncated. Never the argument object: it can hold file contents to write, a
/// credential in an environment assignment, or a whole script.
pub(crate) fn redacted_resource(args: &serde_json::Value) -> Option<String> {
    let raw = args
        .get("command")
        .or_else(|| args.get("path"))
        .or_else(|| args.get("file_path"))
        .or_else(|| args.get("url"))
        .or_else(|| args.get("query"))
        .and_then(|value| value.as_str())?;

    // Collapse whitespace so a multi-line script becomes one readable line.
    let flattened = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.is_empty() {
        return None;
    }
    Some(truncate(&flattened, MAX_RESOURCE_LEN))
}

/// Truncates on a character boundary, marking that it happened.
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}...")
}

/// The fingerprint of a tool call, for repeat detection downstream.
pub(crate) fn call_fingerprint(tool: &str, args: &serde_json::Value) -> String {
    fingerprint(tool, args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jan_agent_harness::fixtures::TempDir;
    use serde_json::json;

    fn recorder(dir: &TempDir) -> RunRecorder {
        RunRecorder::open(dir.path(), None, None, "test-model", false).expect("recorder opens")
    }

    #[test]
    fn opening_a_recorder_writes_a_run_record_and_an_event_log() {
        let dir = TempDir::new("recorder-open");
        let rec = recorder(&dir);
        let run_dir = rec.run_dir();

        assert!(run_dir.join("record.json").is_file());
        rec.emit(EventPayload::TurnStarted { turn: 0 });
        assert!(run_dir.join("events.jsonl").is_file());
    }

    #[test]
    fn events_are_numbered_densely_from_zero() {
        let dir = TempDir::new("recorder-seq");
        let rec = recorder(&dir);
        for turn in 0..5 {
            rec.emit(EventPayload::TurnStarted { turn });
        }

        let events = EventLog::read(rec.run_dir().join("events.jsonl")).unwrap();
        assert_eq!(events.len(), 5);
        for (index, event) in events.iter().enumerate() {
            assert_eq!(event.seq, index as u64);
        }
        assert_eq!(rec.dropped_events(), 0);
    }

    #[test]
    fn every_event_carries_the_same_run_identity() {
        let dir = TempDir::new("recorder-identity");
        let rec = recorder(&dir);
        rec.emit(EventPayload::TurnStarted { turn: 0 });
        rec.emit(EventPayload::TurnStarted { turn: 1 });

        let events = EventLog::read(rec.run_dir().join("events.jsonl")).unwrap();
        for event in &events {
            assert_eq!(&event.identity.run, &rec.identity().run);
            assert_eq!(&event.identity.thread, &rec.identity().thread);
        }
    }

    #[test]
    fn an_existing_thread_id_is_adopted_rather_than_replaced() {
        let dir = TempDir::new("recorder-adopt");
        let thread = ThreadId::new();
        let rec = RunRecorder::open(dir.path(), Some(thread.as_str()), None, "m", false).unwrap();
        assert_eq!(rec.identity().thread, thread);
    }

    #[test]
    fn a_foreign_thread_id_does_not_become_a_harness_id() {
        let dir = TempDir::new("recorder-foreign");
        // The CLI's existing ids are bare UUIDs, not harness ids.
        let rec = RunRecorder::open(
            dir.path(),
            Some("6f1b8c2e-0000-4000-8000-000000000000"),
            None,
            "m",
            false,
        )
        .unwrap();
        assert!(rec.identity().thread.as_str().starts_with("thr_"));
    }

    #[test]
    fn a_finished_run_is_not_reported_as_interrupted() {
        let dir = TempDir::new("recorder-finish");
        let rec = recorder(&dir);
        rec.finish(RunStatus::Completed);

        let store = StateStore::new(dir.path().join(STATE_DIR));
        assert_eq!(
            store.load_for_resume(&rec.identity().run).unwrap().status,
            RunStatus::Completed
        );
    }

    #[test]
    fn a_run_that_never_closed_is_recovered_as_interrupted() {
        let dir = TempDir::new("recorder-crash");
        let rec = recorder(&dir);
        rec.emit(EventPayload::TurnStarted { turn: 0 });
        rec.persist();
        drop(rec); // the process dies here; `finish` is never called

        let store = StateStore::new(dir.path().join(STATE_DIR));
        let run = store.list().unwrap().pop().unwrap();
        assert_eq!(store.load_for_resume(&run).unwrap().status, RunStatus::Interrupted);
    }

    #[test]
    fn the_record_tracks_how_far_the_log_got() {
        let dir = TempDir::new("recorder-progress");
        let rec = recorder(&dir);
        for turn in 0..4 {
            rec.emit(EventPayload::TurnStarted { turn });
        }
        rec.persist();

        let store = StateStore::new(dir.path().join(STATE_DIR));
        assert_eq!(store.load(&rec.identity().run).unwrap().last_event_seq, 3);
    }

    #[test]
    fn a_child_records_into_its_parents_run_under_its_own_agent_id() {
        let dir = TempDir::new("recorder-child");
        let parent = recorder(&dir);
        let child = parent.child();

        assert_eq!(child.identity().run, parent.identity().run);
        assert_eq!(child.identity().thread, parent.identity().thread);
        assert_ne!(child.identity().agent, parent.identity().agent);
        assert_eq!(child.identity().parent_agent.as_ref(), Some(&parent.identity().agent));
        assert_eq!(child.identity().depth, 1);
        assert_eq!(child.run_dir(), parent.run_dir());
    }

    #[test]
    fn parent_and_child_events_interleave_in_one_ordered_log() {
        let dir = TempDir::new("recorder-interleave");
        let parent = recorder(&dir);
        let child = parent.child();

        parent.emit(EventPayload::TurnStarted { turn: 0 });
        child.emit(EventPayload::TurnStarted { turn: 0 });
        parent.emit(EventPayload::TurnStarted { turn: 1 });

        let events = EventLog::read(parent.run_dir().join("events.jsonl")).unwrap();
        assert_eq!(events.len(), 3);
        // One sequence across both agents: the log records the true order.
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(events[0].identity.agent, parent.identity().agent);
        assert_eq!(events[1].identity.agent, child.identity().agent);
        assert_eq!(events[2].identity.agent, parent.identity().agent);
    }

    #[test]
    fn a_grandchild_deepens_rather_than_resetting() {
        let dir = TempDir::new("recorder-depth");
        let parent = recorder(&dir);
        assert_eq!(parent.child().child().identity().depth, 2);
    }

    #[test]
    fn a_shell_command_is_recorded_flattened_and_bounded() {
        let long = "echo ".to_string() + &"x".repeat(1000);
        let resource = redacted_resource(&json!({ "command": long })).unwrap();
        assert!(resource.chars().count() <= MAX_RESOURCE_LEN + 3);
        assert!(resource.ends_with("..."));

        let multiline = redacted_resource(&json!({ "command": "git status\n  && ls" })).unwrap();
        assert_eq!(multiline, "git status && ls");
    }

    #[test]
    fn file_contents_never_reach_the_resource_field() {
        let args = json!({
            "path": "src/secrets.rs",
            "content": "const API_KEY: &str = \"sk-live-do-not-log\";",
        });
        let resource = redacted_resource(&args).unwrap();
        assert_eq!(resource, "src/secrets.rs");
        assert!(!resource.contains("sk-live"));
    }

    #[test]
    fn a_call_with_no_recognised_resource_records_none() {
        assert!(redacted_resource(&json!({})).is_none());
        assert!(redacted_resource(&json!({ "command": "   " })).is_none());
    }

    #[test]
    fn identical_calls_share_a_fingerprint_and_different_ones_do_not() {
        let a = call_fingerprint("bash", &json!({ "command": "ls", "timeout": 5 }));
        let b = call_fingerprint("bash", &json!({ "timeout": 5, "command": "ls" }));
        assert_eq!(a, b);
        assert_ne!(a, call_fingerprint("bash", &json!({ "command": "ls -la" })));
    }
}
