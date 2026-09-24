//! Session-level budget caps for the agent loop. Tracks cumulative token usage
//! across turns and signals when a configured ceiling is reached.

use crate::core::agent::events::Usage;

#[derive(Debug, Default)]
pub(crate) struct SessionBudget {
    max_tokens: Option<u64>,
    spent_tokens: u64,
    last_total: u64,
    last_prompt: Option<u64>,
    /// Whether any usage has been recorded yet. `last_prompt` being `None`
    /// is not the same thing: earlier requests may have reported only a total.
    recorded: bool,
}

impl SessionBudget {
    pub(crate) fn new(max_tokens: Option<u64>) -> Self {
        Self {
            max_tokens,
            spent_tokens: 0,
            last_total: 0,
            last_prompt: None,
            recorded: false,
        }
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
                    // Only the very first request is its own baseline. A
                    // prompt count that first appears after total-only
                    // requests is charged against `last_total` below, or the
                    // spend already folded in is charged twice (#197).
                    (Some(_), None, _) if !self.recorded => total,
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
        self.recorded = true;
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
            ..Default::default()
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
            ..Default::default()
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

    /// A prompt count that first shows up after total-only usage is charged
    /// as the growth since then, not as a fresh baseline (Jozkah/jan#197).
    #[test]
    fn prompt_tokens_appearing_late_do_not_double_charge() {
        let mut budget = SessionBudget::new(None);
        assert_eq!(budget.record(&usage(Some(1000))), 1000);
        assert_eq!(budget.record(&usage_with_parts(1050, 60, 1110)), 1110);
        // And the next request is charged by its prompt growth as usual.
        assert_eq!(budget.record(&usage_with_parts(1150, 40, 1190)), 1110 + 40 + 100);
    }

    #[test]
    fn absent_usage_does_not_advance_spend() {
        let mut b = SessionBudget::new(Some(10));
        assert_eq!(b.record(&None), 0);
        assert!(!b.exhausted());
    }
}
