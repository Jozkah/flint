//! Session-level budget caps for the agent loop. Tracks cumulative token usage
//! and elapsed time across turns, and decides when a run has to stop.
//!
//! `[budget]` describes itself as "the only cap on how long a run may go", and
//! a default ceiling is applied when it is unset -- but crossing it used to
//! append a note and carry on, tool calls included. With `max_turns == 0` the
//! normal case, that left user cancellation as the only real bound on an
//! unattended run's spend. A ceiling that does not stop anything is not a
//! ceiling, so exhaustion now ends the run by default.
//!
//! The previous behaviour is still reachable through
//! `[budget] on_exhausted = "continue"`, because a user who has been relying on
//! a run pushing past its ceiling should be able to keep that, deliberately.

use std::time::{Duration, Instant};

use crate::core::agent::events::Usage;

/// What to do when a run crosses its ceiling.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExhaustionPolicy {
    /// End the run cleanly at the next turn boundary. The default.
    #[default]
    Stop,
    /// Record the crossing and keep going. What the harness used to do.
    Continue,
}

/// Why a run has to stop, when it does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopCause {
    /// The marginal token ceiling was reached.
    TokenBudget,
    /// The wall-clock deadline passed.
    TimeLimit,
}

impl StopCause {
    /// Stable tag for events and logs.
    pub(crate) fn tag(self) -> &'static str {
        match self {
            Self::TokenBudget => "token_budget",
            Self::TimeLimit => "time_limit",
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct SessionBudget {
    max_tokens: Option<u64>,
    spent_tokens: u64,
    last_total: u64,
    last_prompt: Option<u64>,
    /// Wall-clock ceiling for the whole run. Held as a deadline rather than a
    /// duration so every check is a comparison against one fixed instant, not
    /// against an elapsed time that depends on where the clock was read.
    deadline: Option<Instant>,
    policy: ExhaustionPolicy,
}

impl SessionBudget {
    pub(crate) fn new(max_tokens: Option<u64>) -> Self {
        Self {
            max_tokens,
            spent_tokens: 0,
            last_total: 0,
            last_prompt: None,
            deadline: None,
            policy: ExhaustionPolicy::default(),
        }
    }

    /// Sets a wall-clock ceiling, measured from now.
    pub(crate) fn with_time_limit(mut self, limit: Option<Duration>) -> Self {
        self.deadline = limit.filter(|d| !d.is_zero()).map(|d| Instant::now() + d);
        self
    }

    /// Sets what happens when a ceiling is crossed.
    pub(crate) fn with_policy(mut self, policy: ExhaustionPolicy) -> Self {
        self.policy = policy;
        self
    }

    pub(crate) fn max_tokens(&self) -> Option<u64> {
        self.max_tokens
    }

    /// How long this run has left, or `None` when it has no deadline.
    ///
    /// Zero once the deadline has passed, so a caller handing this to a child
    /// cannot accidentally grant it a fresh window.
    pub(crate) fn time_remaining(&self) -> Option<Duration> {
        self.deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }

    /// True once a configured wall-clock ceiling has passed.
    pub(crate) fn expired(&self) -> bool {
        matches!(self.deadline, Some(deadline) if Instant::now() >= deadline)
    }

    /// Why this run must stop, or `None` while it may continue.
    ///
    /// Returns `None` under `ExhaustionPolicy::Continue` even when a ceiling has
    /// been crossed: the crossing is still reported, it just does not end the
    /// run.
    pub(crate) fn stop_cause(&self) -> Option<StopCause> {
        if self.policy == ExhaustionPolicy::Continue {
            return None;
        }
        if self.expired() {
            return Some(StopCause::TimeLimit);
        }
        if self.exhausted() {
            return Some(StopCause::TokenBudget);
        }
        None
    }

    /// Fold a completion's usage into the running total, returning the new total.
    ///
    /// Counts new completion tokens and positive prompt-token growth rather than
    /// replayed prompt history. The first request uses its reported total as the
    /// baseline. When providers omit prompt or completion fields, the total-token
    /// delta remains the fallback.
    pub(crate) fn record(&mut self, usage: &Option<Usage>) -> u64 {
        let Some(usage) = usage.as_ref() else {
            return self.spent_tokens;
        };

        let delta = match usage.total_tokens {
            Some(total) => {
                let delta = match (
                    usage.prompt_tokens,
                    self.last_prompt,
                    usage.completion_tokens,
                ) {
                    (Some(prompt), Some(last_prompt), Some(completion)) => {
                        completion.saturating_add(prompt.saturating_sub(last_prompt))
                    }
                    (Some(_), None, _) => total,
                    (_, Some(_), Some(completion)) => {
                        completion.max(total.saturating_sub(self.last_total))
                    }
                    _ => total.saturating_sub(self.last_total),
                };
                self.last_total = total;
                delta
            }
            None => usage.completion_tokens.unwrap_or(0),
        };

        self.last_prompt = usage.prompt_tokens.or(self.last_prompt);
        self.spent_tokens = self.spent_tokens.saturating_add(delta);
        self.spent_tokens
    }

    pub(crate) fn spent(&self) -> u64 {
        self.spent_tokens
    }

    /// True only when a ceiling is configured and has been reached or exceeded.
    pub(crate) fn exhausted(&self) -> bool {
        matches!(self.max_tokens, Some(max) if self.spent_tokens >= max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::events::Usage;

    fn usage(total: Option<u64>) -> Option<Usage> {
        Some(Usage {
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: total,
        })
    }

    fn usage_with_parts(
        prompt_tokens: u64,
        completion_tokens: u64,
        total_tokens: u64,
    ) -> Option<Usage> {
        Some(Usage {
            prompt_tokens: Some(prompt_tokens),
            completion_tokens: Some(completion_tokens),
            total_tokens: Some(total_tokens),
        })
    }

    #[test]
    fn compaction_still_charges_completion_tokens() {
        let mut b = SessionBudget::new(Some(1_100));
        b.record(&usage_with_parts(900, 100, 1_000));
        assert!(!b.exhausted());

        // The compacted prompt is smaller, but this request still consumed
        // another 100 completion tokens and must exhaust the session budget.
        b.record(&usage_with_parts(400, 100, 500));
        assert_eq!(b.spent(), 1_100);
        assert!(b.exhausted());
    }

    #[test]
    fn no_ceiling_is_never_exhausted() {
        let mut b = SessionBudget::new(None);
        assert_eq!(b.record(&usage(Some(1_000_000))), 1_000_000);
        assert!(!b.exhausted());
    }

    #[test]
    fn accumulates_marginal_spend_and_exhausts_at_or_over_ceiling() {
        let mut b = SessionBudget::new(Some(100));
        // First request counts its full total, since there is no baseline yet.
        b.record(&usage(Some(60)));
        assert!(!b.exhausted());
        // Context grew by only a little between requests, so only the marginal
        // increase counts — the replayed prior history must not be double-charged.
        b.record(&usage(Some(64)));
        assert_eq!(b.spent(), 64);
        assert!(!b.exhausted());
        // A big single-request increase (e.g. a large new completion) trips it.
        b.record(&usage(Some(200)));
        assert_eq!(b.spent(), 200);
        assert!(b.exhausted());
    }

    #[test]
    fn compaction_does_not_refund_or_double_charge_spend() {
        let mut b = SessionBudget::new(Some(100));
        b.record(&usage(Some(60)));
        b.record(&usage(Some(90)));
        assert_eq!(b.spent(), 90);
        // Compaction shrinks the replay below the last total; must not refund, and
        // later small growth is counted from the compacted baseline.
        b.record(&usage(Some(70)));
        assert_eq!(b.spent(), 90);
        b.record(&usage(Some(80)));
        assert_eq!(b.spent(), 100);
        assert!(b.exhausted());
    }

    #[test]
    fn a_crossed_ceiling_stops_the_run_by_default() {
        let mut b = SessionBudget::new(Some(100));
        b.record(&usage(Some(150)));
        assert!(b.exhausted());
        assert_eq!(b.stop_cause(), Some(StopCause::TokenBudget));
    }

    #[test]
    fn continue_policy_reports_the_crossing_without_stopping() {
        let mut b = SessionBudget::new(Some(100)).with_policy(ExhaustionPolicy::Continue);
        b.record(&usage(Some(150)));
        // Still exhausted -- the crossing is a fact, and it is still reported.
        assert!(b.exhausted());
        // It just is not a reason to stop.
        assert_eq!(b.stop_cause(), None);
    }

    #[test]
    fn no_ceiling_never_produces_a_stop_cause() {
        let mut b = SessionBudget::new(None);
        b.record(&usage(Some(10_000_000)));
        assert_eq!(b.stop_cause(), None);
    }

    #[test]
    fn an_elapsed_time_limit_stops_the_run() {
        let b = SessionBudget::new(None).with_time_limit(Some(Duration::from_nanos(1)));
        std::thread::sleep(Duration::from_millis(5));
        assert!(b.expired());
        assert_eq!(b.stop_cause(), Some(StopCause::TimeLimit));
    }

    #[test]
    fn a_time_limit_in_the_future_does_not_stop_the_run() {
        let b = SessionBudget::new(None).with_time_limit(Some(Duration::from_secs(3600)));
        assert!(!b.expired());
        assert_eq!(b.stop_cause(), None);
    }

    #[test]
    fn a_zero_time_limit_means_unlimited_not_already_expired() {
        // `0` disables a ceiling everywhere else in this config; it must not
        // mean "stop before the first turn".
        let b = SessionBudget::new(None).with_time_limit(Some(Duration::ZERO));
        assert!(!b.expired());
        assert_eq!(b.stop_cause(), None);
    }

    #[test]
    fn time_is_reported_before_tokens_when_both_are_crossed() {
        let mut b = SessionBudget::new(Some(10)).with_time_limit(Some(Duration::from_nanos(1)));
        b.record(&usage(Some(100)));
        std::thread::sleep(Duration::from_millis(5));
        // Either is a correct reason to stop; the run reports one, and a
        // deadline is the more urgent fact about it.
        assert_eq!(b.stop_cause(), Some(StopCause::TimeLimit));
    }

    #[test]
    fn stop_causes_have_distinct_stable_tags() {
        assert_eq!(StopCause::TokenBudget.tag(), "token_budget");
        assert_eq!(StopCause::TimeLimit.tag(), "time_limit");
    }

    #[test]
    fn absent_usage_does_not_advance_spend() {
        let mut b = SessionBudget::new(Some(10));
        assert_eq!(b.record(&None), 0);
        assert!(!b.exhausted());
    }
}
