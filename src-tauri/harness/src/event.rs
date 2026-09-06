//! The canonical harness event stream (AHD-002).
//!
//! One event type, many renderings. Streaming to a UI, the display journal, the
//! permission audit log, replay and the headless event API are all consumers of
//! this stream rather than parallel implementations of it. The existing
//! `StreamEvent` is a UI-streaming type that is never persisted, which is why
//! replay, audit logging, export and event streaming are all currently absent.
//!
//! Two rules hold for anything added here:
//!
//! 1. **Events carry no raw tool arguments.** Arguments can contain credentials
//!    and file contents, and events are written to disk and exported. Emitters
//!    pass a redacted `resource` plus a [`fingerprint`], never the payload.
//! 2. **Events are facts, not instructions.** An event records that something
//!    happened. Nothing downstream may need an event to decide authority.

use serde::{Deserialize, Serialize};

use crate::error::{Audience, ErrorKind};
use crate::identity::{AgentId, RunIdentity};

/// How a tool call ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcome {
    Ok,
    Failed,
    Denied,
    Cancelled,
    TimedOut,
}

/// What a human decided when asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    AllowAlways,
    Deny,
    /// Granted without asking, because policy or an auto-approve setting allowed it.
    AutoAllowed,
}

/// Provider-reported token usage for one request.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// Everything the harness can observe about a run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventPayload {
    RunStarted { model: String, plan_mode: bool },
    RunFinished { outcome: ToolOutcome },
    TurnStarted { turn: u32 },
    TurnFinished { turn: u32, usage: Usage },

    /// A tool call was dispatched. `resource` is the redacted path, command or
    /// server the call touches; `fingerprint` identifies repeats (`AH-030`).
    ToolCalled { call_id: String, tool: String, resource: Option<String>, fingerprint: String },
    /// A tool call ended. `duration_ms` is absent when the dispatcher did not
    /// measure this call individually -- an unknown duration must read as
    /// unknown, not as zero, in a record someone audits.
    ToolFinished {
        call_id: String,
        tool: String,
        outcome: ToolOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },

    PermissionRequested { call_id: String, tool: String, resource: Option<String> },
    PermissionDecided { call_id: String, tool: String, decision: PermissionDecision },

    AskRequested { ask_id: String, question: String },
    AskAnswered { ask_id: String, answered: bool },

    SubagentStarted { agent: AgentId, name: String },
    SubagentFinished { agent: AgentId, outcome: ToolOutcome },

    TodoUpdated { pending: u32, in_progress: u32, completed: u32, abandoned: u32 },
    Compacted { messages_removed: u32, tokens_before: u64, tokens_after: u64 },
    CheckpointCreated { checkpoint: String, label: String },
    BudgetCrossed { budget: String, spent: u64, limit: u64, exhausted: bool },

    ErrorRaised { kind: ErrorKind, message: String, audience: Audience },

    /// An event written by a newer build than the one reading it.
    ///
    /// Preserved verbatim so an old reader neither drops nor corrupts a log it
    /// only partly understands (AHD-010).
    #[serde(skip)]
    Unknown { kind: String, raw: serde_json::Value },
}

impl EventPayload {
    /// The stable discriminant, used for filtering and for the wire envelope.
    pub fn kind(&self) -> String {
        match self {
            Self::RunStarted { .. } => "run_started".into(),
            Self::RunFinished { .. } => "run_finished".into(),
            Self::TurnStarted { .. } => "turn_started".into(),
            Self::TurnFinished { .. } => "turn_finished".into(),
            Self::ToolCalled { .. } => "tool_called".into(),
            Self::ToolFinished { .. } => "tool_finished".into(),
            Self::PermissionRequested { .. } => "permission_requested".into(),
            Self::PermissionDecided { .. } => "permission_decided".into(),
            Self::AskRequested { .. } => "ask_requested".into(),
            Self::AskAnswered { .. } => "ask_answered".into(),
            Self::SubagentStarted { .. } => "subagent_started".into(),
            Self::SubagentFinished { .. } => "subagent_finished".into(),
            Self::TodoUpdated { .. } => "todo_updated".into(),
            Self::Compacted { .. } => "compacted".into(),
            Self::CheckpointCreated { .. } => "checkpoint_created".into(),
            Self::BudgetCrossed { .. } => "budget_crossed".into(),
            Self::ErrorRaised { .. } => "error_raised".into(),
            Self::Unknown { kind, .. } => kind.clone(),
        }
    }

    /// Whether this event must reach the durable audit record (`AH-049`, `AH-050`).
    ///
    /// Anything that exercised or granted authority qualifies. An unknown event
    /// qualifies too: a reader that cannot interpret an event is in no position
    /// to decide it is not security-relevant.
    pub fn is_audit_relevant(&self) -> bool {
        matches!(
            self,
            Self::ToolCalled { .. }
                | Self::ToolFinished { .. }
                | Self::PermissionRequested { .. }
                | Self::PermissionDecided { .. }
                | Self::SubagentStarted { .. }
                | Self::SubagentFinished { .. }
                | Self::RunStarted { .. }
                | Self::RunFinished { .. }
                | Self::Unknown { .. }
        )
    }
}

/// One event in a run's stream.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HarnessEvent {
    /// Position in the run's stream, from 0, dense and gapless.
    ///
    /// Replay and audit both depend on being able to notice a missing event, so
    /// the sequence is the run's own counter rather than a wall-clock ordering.
    pub seq: u64,
    /// Milliseconds since the Unix epoch. For display; never for ordering.
    pub at_ms: u64,
    pub identity: RunIdentity,
    pub payload: EventPayload,
}

impl HarnessEvent {
    /// Builds an event stamped with the current wall clock.
    pub fn new(seq: u64, identity: RunIdentity, payload: EventPayload) -> Self {
        Self { seq, at_ms: now_ms(), identity, payload }
    }

    /// Builds an event at an explicit time, so tests are deterministic.
    pub fn at(seq: u64, at_ms: u64, identity: RunIdentity, payload: EventPayload) -> Self {
        Self { seq, at_ms, identity, payload }
    }

    pub fn kind(&self) -> String {
        self.payload.kind()
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A stable fingerprint of a tool call, for detecting repeats.
///
/// FNV-1a over the tool name and its canonical arguments. This is a similarity
/// key for loop detection (`AH-030`), not a security primitive: it is unkeyed
/// and must never be used to authenticate anything.
pub fn fingerprint(tool: &str, arguments: &serde_json::Value) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = OFFSET;
    let mut absorb = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(PRIME);
        }
    };
    absorb(tool.as_bytes());
    absorb(b"\0");
    // `to_string` on a serde_json::Value orders object keys as parsed. Sorting
    // through a BTreeMap keeps the fingerprint stable across argument orderings.
    absorb(canonical(arguments).as_bytes());
    format!("{hash:016x}")
}

fn canonical(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let sorted: std::collections::BTreeMap<_, _> =
                map.iter().map(|(k, v)| (k.as_str(), canonical(v))).collect();
            let body = sorted
                .into_iter()
                .map(|(k, v)| format!("{k:?}:{v}"))
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        serde_json::Value::Array(items) => {
            format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(","))
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{SessionId, ThreadId};
    use serde_json::json;

    fn identity() -> RunIdentity {
        RunIdentity::root(ThreadId::new(), SessionId::new())
    }

    #[test]
    fn every_payload_kind_is_distinct() {
        let payloads = vec![
            EventPayload::RunStarted { model: "m".into(), plan_mode: false },
            EventPayload::RunFinished { outcome: ToolOutcome::Ok },
            EventPayload::TurnStarted { turn: 1 },
            EventPayload::TurnFinished { turn: 1, usage: Usage::default() },
            EventPayload::ToolCalled {
                call_id: "c".into(),
                tool: "read".into(),
                resource: None,
                fingerprint: "f".into(),
            },
            EventPayload::ToolFinished {
                call_id: "c".into(),
                tool: "read".into(),
                outcome: ToolOutcome::Ok,
                duration_ms: Some(1),
            },
            EventPayload::PermissionRequested { call_id: "c".into(), tool: "bash".into(), resource: None },
            EventPayload::PermissionDecided {
                call_id: "c".into(),
                tool: "bash".into(),
                decision: PermissionDecision::Deny,
            },
            EventPayload::AskRequested { ask_id: "a".into(), question: "?".into() },
            EventPayload::AskAnswered { ask_id: "a".into(), answered: true },
            EventPayload::SubagentStarted { agent: AgentId::new(), name: "r".into() },
            EventPayload::SubagentFinished { agent: AgentId::new(), outcome: ToolOutcome::Ok },
            EventPayload::TodoUpdated { pending: 1, in_progress: 0, completed: 0, abandoned: 0 },
            EventPayload::Compacted { messages_removed: 1, tokens_before: 2, tokens_after: 1 },
            EventPayload::CheckpointCreated { checkpoint: "c".into(), label: "l".into() },
            EventPayload::BudgetCrossed {
                budget: "tokens".into(),
                spent: 2,
                limit: 1,
                exhausted: true,
            },
            EventPayload::ErrorRaised {
                kind: ErrorKind::Internal,
                message: "x".into(),
                audience: Audience::Internal,
            },
        ];
        let kinds: std::collections::HashSet<_> = payloads.iter().map(|p| p.kind()).collect();
        assert_eq!(kinds.len(), payloads.len());
    }

    #[test]
    fn authority_events_are_audit_relevant() {
        let decided = EventPayload::PermissionDecided {
            call_id: "c".into(),
            tool: "bash".into(),
            decision: PermissionDecision::AutoAllowed,
        };
        assert!(decided.is_audit_relevant());
        assert!(EventPayload::ToolCalled {
            call_id: "c".into(),
            tool: "bash".into(),
            resource: Some("git status".into()),
            fingerprint: "f".into(),
        }
        .is_audit_relevant());
    }

    #[test]
    fn presentation_events_are_not_audit_relevant() {
        assert!(!EventPayload::TurnStarted { turn: 1 }.is_audit_relevant());
        assert!(!EventPayload::TodoUpdated {
            pending: 0,
            in_progress: 0,
            completed: 1,
            abandoned: 0
        }
        .is_audit_relevant());
    }

    #[test]
    fn an_unreadable_event_is_treated_as_audit_relevant() {
        let unknown = EventPayload::Unknown { kind: "future_thing".into(), raw: json!({}) };
        assert!(unknown.is_audit_relevant());
        assert_eq!(unknown.kind(), "future_thing");
    }

    #[test]
    fn identical_calls_share_a_fingerprint() {
        let a = fingerprint("bash", &json!({ "command": "ls", "timeout": 30 }));
        let b = fingerprint("bash", &json!({ "timeout": 30, "command": "ls" }));
        assert_eq!(a, b, "key order must not change the fingerprint");
    }

    #[test]
    fn different_calls_do_not_share_a_fingerprint() {
        let ls = fingerprint("bash", &json!({ "command": "ls" }));
        assert_ne!(ls, fingerprint("bash", &json!({ "command": "rm -rf /" })));
        assert_ne!(ls, fingerprint("read", &json!({ "command": "ls" })));
    }

    #[test]
    fn nested_arguments_are_canonicalised() {
        let a = fingerprint("t", &json!({ "o": { "b": 1, "a": [1, 2] } }));
        let b = fingerprint("t", &json!({ "o": { "a": [1, 2], "b": 1 } }));
        assert_eq!(a, b);
        assert_ne!(a, fingerprint("t", &json!({ "o": { "a": [2, 1], "b": 1 } })));
    }

    #[test]
    fn an_event_records_its_position_and_identity() {
        let id = identity();
        let event = HarnessEvent::at(7, 1234, id.clone(), EventPayload::TurnStarted { turn: 2 });
        assert_eq!(event.seq, 7);
        assert_eq!(event.at_ms, 1234);
        assert_eq!(event.identity.run, id.run);
        assert_eq!(event.kind(), "turn_started");
    }
}
