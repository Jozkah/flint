//! Why a run ended, as one typed value every surface reads.
//!
//! The loop already classifies a failure (`ErrorKind`, AH-009) and names a
//! finish reason on a completion, but "the run stopped" was still told several
//! ways: the CLI exited 53 for the turn limit and the kind's own code for
//! everything else, the JSON envelope had a free-text `stop_reason`, and the
//! desktop wrote its own sentence. [`EndReason`] is the one answer, derived in
//! one place from what the run actually returned, so the event stream, the
//! envelope, the exit status and the sentence a person reads cannot disagree.

use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError};

/// How a run ended. The tags are stable: scripts and transcripts outlive
/// releases.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    /// The model returned its answer and the run finished.
    Completed,
    /// The user (or an enclosing scope) asked the run to stop.
    UserStop,
    /// A token, cost or wall-clock budget ran out.
    Budget,
    /// `max_turns` ran out with the model still calling tools.
    TurnLimit,
    /// Something said no and the run could not go on: the model's provider
    /// filtered the answer, or a permission, approval or sandbox refused.
    Refusal,
    /// The run failed.
    Error,
    /// Another process took over the run.
    LeaseLost,
}

/// The message marker that separates a turn-limit stop from the other budget
/// exhaustions (the error kind is shared with them).
const TURN_LIMIT_MARKER: &str = "-turn limit while the model was still calling tools";

/// Whether `e` (or a cause of it) is the loop's turn-limit exhaustion.
pub fn is_turn_limit(e: &HarnessError) -> bool {
    e.chain().into_iter().any(|cause| {
        cause.kind() == ErrorKind::BudgetExhausted
            && cause.message().starts_with("reached the ")
            && cause.message().ends_with(TURN_LIMIT_MARKER)
    })
}

impl EndReason {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::UserStop => "user_stop",
            Self::Budget => "budget",
            Self::TurnLimit => "turn_limit",
            Self::Refusal => "refusal",
            Self::Error => "error",
            Self::LeaseLost => "lease_lost",
        }
    }

    /// The status a command ends with for this reason. For a failure the kind's
    /// own `sysexits` code is kept, so `error` is the one reason that does not
    /// have a code of its own.
    pub fn exit_code(self, failure: Option<&HarnessError>) -> i32 {
        match self {
            Self::Completed => 0,
            Self::UserStop => 130,
            Self::Budget => 75,
            Self::TurnLimit => 53,
            Self::Refusal => 77,
            Self::LeaseLost => 73,
            Self::Error => failure.map(HarnessError::exit_code).unwrap_or(70),
        }
    }

    /// The sentence the desktop shows beside a finished run.
    pub fn label(self) -> &'static str {
        match self {
            Self::Completed => "Finished.",
            Self::UserStop => "Stopped by you.",
            Self::Budget => "Stopped: the budget ran out.",
            Self::TurnLimit => "Stopped: the turn limit was reached before the work was done.",
            Self::Refusal => "Stopped: the request was refused.",
            Self::Error => "Stopped: the run failed.",
            Self::LeaseLost => "Stopped: another process took over this run.",
        }
    }

    /// The reason a run that returned `error` ended for.
    pub fn from_error(e: &HarnessError) -> Self {
        if is_turn_limit(e) {
            return Self::TurnLimit;
        }
        match e.kind() {
            ErrorKind::Cancelled => Self::UserStop,
            ErrorKind::BudgetExhausted | ErrorKind::Timeout => Self::Budget,
            ErrorKind::LeaseLost => Self::LeaseLost,
            ErrorKind::PermissionDenied
            | ErrorKind::ApprovalRefused
            | ErrorKind::SandboxDenied
            | ErrorKind::PolicyViolation => Self::Refusal,
            _ => Self::Error,
        }
    }

    /// The reason a run that completed with `finish_reason` ended for. A
    /// completion the loop cut short (cost ceiling, turn limit) or the provider
    /// filtered is not a plain finish.
    pub fn from_finish(finish_reason: &str) -> Self {
        match finish_reason {
            "budget_exceeded" => Self::Budget,
            "turn_limit_exceeded" => Self::TurnLimit,
            "content_filter" => Self::Refusal,
            _ => Self::Completed,
        }
    }

    /// Reads a tag from an event's `code` (an error kind tag) when only the
    /// code is at hand.
    pub fn from_code(code: &str) -> Self {
        match code {
            "cancelled" => Self::UserStop,
            "budget_exhausted" | "timeout" => Self::Budget,
            "lease_lost" => Self::LeaseLost,
            "permission_denied" | "approval_refused" | "sandbox_denied" | "policy_violation" => Self::Refusal,
            _ => Self::Error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_agent_tools::harness_error::Stage;

    fn turn_limit() -> HarnessError {
        HarnessError::new(
            ErrorKind::BudgetExhausted,
            format!("reached the 3{TURN_LIMIT_MARKER}"),
        )
        .at(Stage::Context)
    }

    #[test]
    fn each_ending_has_its_own_reason_and_exit_code() {
        let cases: Vec<(HarnessError, EndReason, i32)> = vec![
            (HarnessError::cancelled("stop"), EndReason::UserStop, 130),
            (HarnessError::new(ErrorKind::BudgetExhausted, "session token budget spent"), EndReason::Budget, 75),
            (turn_limit(), EndReason::TurnLimit, 53),
            (HarnessError::denied("no"), EndReason::Refusal, 77),
            (HarnessError::new(ErrorKind::Upstream, "502"), EndReason::Error, 69),
            (HarnessError::new(ErrorKind::LeaseLost, "taken"), EndReason::LeaseLost, 73),
        ];
        let mut tags = std::collections::HashSet::new();
        for (err, reason, code) in cases {
            assert_eq!(EndReason::from_error(&err), reason, "{err}");
            assert_eq!(reason.exit_code(Some(&err)), code, "{reason:?}");
            assert!(tags.insert(reason.tag()), "tags are distinct");
            assert!(!reason.label().is_empty());
        }
        assert_eq!(EndReason::Completed.exit_code(None), 0);
    }

    #[test]
    fn a_turn_limit_is_not_mistaken_for_another_budget() {
        let other = HarnessError::new(ErrorKind::BudgetExhausted, "reached the 3-turn limit of some other thing");
        assert_eq!(EndReason::from_error(&other), EndReason::Budget);
        assert_eq!(EndReason::from_error(&turn_limit()), EndReason::TurnLimit);
        // Found through a cause too.
        let wrapped = HarnessError::new(ErrorKind::ChildFailed, "child").caused_by(turn_limit());
        assert_eq!(EndReason::from_error(&wrapped), EndReason::TurnLimit);
    }

    #[test]
    fn completions_cut_short_are_not_plain_finishes() {
        assert_eq!(EndReason::from_finish("stop"), EndReason::Completed);
        assert_eq!(EndReason::from_finish("length"), EndReason::Completed);
        assert_eq!(EndReason::from_finish("budget_exceeded"), EndReason::Budget);
        assert_eq!(EndReason::from_finish("turn_limit_exceeded"), EndReason::TurnLimit);
        assert_eq!(EndReason::from_finish("content_filter"), EndReason::Refusal);
    }

    #[test]
    fn a_bare_error_code_maps_the_same_way_as_the_error() {
        for kind in ErrorKind::all() {
            let err = HarnessError::new(*kind, "x");
            if is_turn_limit(&err) {
                continue;
            }
            assert_eq!(EndReason::from_code(kind.tag()), EndReason::from_error(&err), "{kind:?}");
        }
    }
}
