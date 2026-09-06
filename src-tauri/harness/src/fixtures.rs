//! Shared builders for harness tests (`AH-011`).
//!
//! Harness tests otherwise hand-roll identities, event streams and temporary
//! directories, and every lane hand-rolls them slightly differently. That is how
//! a test suite ends up asserting on the fixture rather than the behaviour.
//!
//! Compiled unconditionally so that other crates in the workspace can use these
//! from their own `#[cfg(test)]` modules without a dev-dependency cycle.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::event::{EventPayload, HarnessEvent, ToolOutcome, Usage};
use crate::identity::{RunIdentity, SessionId, ThreadId};

/// A directory that deletes itself when it goes out of scope.
///
/// The harness has no `tempfile` dependency and this crate is deliberately
/// dependency-light, so tests that need a real filesystem get one here. Cleanup
/// is best-effort in `Drop`: a test that has already failed should not fail
/// again on teardown and hide the real assertion.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// Creates a uniquely named directory under the system temp directory.
    ///
    /// The name carries a process-wide counter as well as the clock: two
    /// fixtures built in the same millisecond must not land on one path, or
    /// each would delete the other's directory out from under it.
    pub fn new(label: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = format!(
            "jan-harness-{label}-{}-{}-{}",
            std::process::id(),
            crate::event::now_ms(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
        );
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).expect("failed to create a temporary directory");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A run identity with fresh thread and session ids.
pub fn identity() -> RunIdentity {
    RunIdentity::root(ThreadId::new(), SessionId::new())
}

/// Builds a deterministic event stream for one identity.
///
/// Sequence numbers start at zero and timestamps advance by a fixed step, so a
/// test that asserts on ordering asserts on the harness and not on the clock.
pub struct EventStreamBuilder {
    identity: RunIdentity,
    events: Vec<HarnessEvent>,
    at_ms: u64,
}

impl EventStreamBuilder {
    pub const START_MS: u64 = 1_700_000_000_000;
    pub const STEP_MS: u64 = 1_000;

    pub fn new(identity: RunIdentity) -> Self {
        Self { identity, events: Vec::new(), at_ms: Self::START_MS }
    }

    /// Appends a payload, assigning the next sequence number and timestamp.
    pub fn push(mut self, payload: EventPayload) -> Self {
        let seq = self.events.len() as u64;
        self.events.push(HarnessEvent::at(seq, self.at_ms, self.identity.clone(), payload));
        self.at_ms += Self::STEP_MS;
        self
    }

    /// Appends a matched tool call and completion, the shape most tests need.
    pub fn tool_call(self, call_id: &str, tool: &str, outcome: ToolOutcome) -> Self {
        self.push(EventPayload::ToolCalled {
            call_id: call_id.to_string(),
            tool: tool.to_string(),
            resource: None,
            fingerprint: crate::event::fingerprint(tool, &serde_json::json!({ "call": call_id })),
        })
        .push(EventPayload::ToolFinished {
            call_id: call_id.to_string(),
            tool: tool.to_string(),
            outcome,
            duration_ms: Some(5),
        })
    }

    pub fn build(self) -> Vec<HarnessEvent> {
        self.events
    }
}

/// A short, complete run: start, one turn, one successful tool call, finish.
pub fn sample_run(identity: RunIdentity) -> Vec<HarnessEvent> {
    EventStreamBuilder::new(identity)
        .push(EventPayload::RunStarted { model: "test-model".into(), plan_mode: false })
        .push(EventPayload::TurnStarted { turn: 0 })
        .tool_call("call-1", "read", ToolOutcome::Ok)
        .push(EventPayload::TurnFinished {
            turn: 0,
            usage: Usage { prompt_tokens: 100, completion_tokens: 20 },
        })
        .push(EventPayload::RunFinished { outcome: ToolOutcome::Ok })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_temp_dir_exists_while_held_and_is_gone_after() {
        let path = {
            let dir = TempDir::new("selftest");
            assert!(dir.path().is_dir());
            std::fs::write(dir.path().join("file"), "data").unwrap();
            dir.path().to_path_buf()
        };
        assert!(!path.exists(), "the temporary directory outlived its guard");
    }

    #[test]
    fn temp_dirs_do_not_collide() {
        let a = TempDir::new("collide");
        let b = TempDir::new("collide");
        assert_ne!(a.path(), b.path());
    }

    #[test]
    fn a_built_stream_is_densely_and_monotonically_ordered() {
        let events = sample_run(identity());
        assert!(!events.is_empty());
        for (index, event) in events.iter().enumerate() {
            assert_eq!(event.seq, index as u64);
        }
        for pair in events.windows(2) {
            assert!(pair[1].at_ms > pair[0].at_ms);
        }
    }

    #[test]
    fn every_event_in_a_stream_shares_one_run() {
        let events = sample_run(identity());
        let runs: std::collections::HashSet<_> =
            events.iter().map(|e| e.identity.run.to_string()).collect();
        assert_eq!(runs.len(), 1);
    }

    #[test]
    fn a_tool_call_is_paired_with_its_completion() {
        let events = EventStreamBuilder::new(identity())
            .tool_call("c1", "bash", ToolOutcome::Denied)
            .build();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind(), "tool_called");
        assert_eq!(events[1].kind(), "tool_finished");
    }
}
