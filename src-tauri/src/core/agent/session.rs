//! Session-level budget caps for the agent loop. Tracks cumulative token usage
//! across turns and signals when a configured ceiling is reached.

use crate::core::agent::events::Usage;

/// What a provider charges per token, in USD (upstream #9034). The rates a run
/// started with, snapshotted: a money ceiling is enforced against the prices in
/// force when it was set, not against a file edited mid-run.
///
/// In this fork the rates come from the person-declared `prices.toml`
/// (`core::agent::spend`, AH-175), converted from dollars per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TokenRates {
    pub prompt_usd: f64,
    pub completion_usd: f64,
    /// A rate nobody declared falls back to the prompt rate.
    pub cache_read_usd: Option<f64>,
    pub cache_write_usd: Option<f64>,
}

impl TokenRates {
    /// USD for one request's token counts. `cached` and `cache_write` are
    /// **shares of `prompt`**, not additions to it; each share is billed at its
    /// own rate and the remainder at the prompt rate.
    pub fn cost_usd(&self, prompt: u64, completion: u64, cached: u64, cache_write: u64) -> f64 {
        let cached = cached.min(prompt);
        let written = cache_write.min(prompt - cached);
        let fresh = prompt - cached - written;
        fresh as f64 * self.prompt_usd
            + cached as f64 * self.cache_read_usd.unwrap_or(self.prompt_usd)
            + written as f64 * self.cache_write_usd.unwrap_or(self.prompt_usd)
            + completion as f64 * self.completion_usd
    }

    /// USD for one reported usage record. An omitted count contributes nothing
    /// rather than being guessed at.
    fn cost_of(&self, usage: &Usage) -> f64 {
        self.cost_usd(
            usage.prompt_tokens.unwrap_or(0),
            usage.completion_tokens.unwrap_or(0),
            usage.cached_prompt_tokens.unwrap_or(0),
            usage.cache_write_tokens.unwrap_or(0),
        )
    }
}

/// A run's money ceiling: the rates to charge at, and the limit to stop at.
/// Both or neither -- a ceiling with no rates cannot be enforced, and the CLI
/// refuses such a run up front rather than letting it proceed uncapped.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CostCeiling {
    pub rates: TokenRates,
    pub max_usd: f64,
}

#[derive(Debug, Default)]
pub(crate) struct SessionBudget {
    max_tokens: Option<u64>,
    spent_tokens: u64,
    last_total: u64,
    last_prompt: Option<u64>,
    /// Whether any usage has been recorded yet. `last_prompt` being `None`
    /// is not the same thing: earlier requests may have reported only a total.
    recorded: bool,
    /// `None` leaves money unmetered, which is the default.
    ceiling: Option<CostCeiling>,
    spent_usd: f64,
}

impl SessionBudget {
    pub(crate) fn new(max_tokens: Option<u64>) -> Self {
        Self {
            max_tokens,
            spent_tokens: 0,
            last_total: 0,
            last_prompt: None,
            recorded: false,
            ceiling: None,
            spent_usd: 0.0,
        }
    }

    /// Meter this run's spend against a money ceiling.
    pub(crate) fn with_cost_ceiling(mut self, ceiling: Option<CostCeiling>) -> Self {
        self.ceiling = ceiling;
        self
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
        // Money is charged on the request as billed -- the whole prompt, every
        // time -- rather than on the marginal `delta` above: a provider bills
        // the whole prompt it is resent on every request.
        if let Some(ceiling) = &self.ceiling {
            self.spent_usd += ceiling.rates.cost_of(usage);
        }
        self.spent_tokens
    }

    /// USD charged so far, or `None` when this run meters no money at all --
    /// which is not the same as having spent nothing.
    pub(crate) fn spent_usd(&self) -> Option<f64> {
        self.ceiling.is_some().then_some(self.spent_usd)
    }

    pub(crate) fn max_usd(&self) -> Option<f64> {
        self.ceiling.as_ref().map(|c| c.max_usd)
    }

    /// True once the money ceiling is reached. This **stops the run**. Checked
    /// after a request rather than before, because a request's cost is not
    /// known until the provider reports its usage, so the overshoot is bounded
    /// by one request.
    pub(crate) fn over_cost_ceiling(&self) -> bool {
        matches!(self.ceiling, Some(c) if self.spent_usd >= c.max_usd)
    }

    /// Charge a side request's whole cost (the completion verifier's), which
    /// is not part of the conversation's prompt growth and so must not move
    /// the baselines `record` measures that growth from (#131).
    pub(crate) fn charge(&mut self, tokens: u64) -> u64 {
        self.spent_tokens = self.spent_tokens.saturating_add(tokens);
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

    fn rates() -> TokenRates {
        TokenRates {
            prompt_usd: 1e-6,
            completion_usd: 10e-6,
            cache_read_usd: None,
            cache_write_usd: None,
        }
    }

    fn capped(max_usd: f64) -> SessionBudget {
        SessionBudget::new(None).with_cost_ceiling(Some(CostCeiling {
            rates: rates(),
            max_usd,
        }))
    }

    /// Money is cumulative where tokens are marginal: every request pays for
    /// its whole prompt.
    #[test]
    fn cost_charges_every_request_for_the_whole_prompt() {
        let mut b = capped(1.0);
        b.record(&usage_with_parts(10_000, 100, 10_100));
        b.record(&usage_with_parts(10_100, 100, 10_200));
        b.record(&usage_with_parts(10_200, 100, 10_300));
        let spent = b.spent_usd().expect("metered");
        assert!(
            (spent - (30_300.0 * 1e-6 + 300.0 * 10e-6)).abs() < 1e-9,
            "every request pays for its whole prompt: {spent}"
        );
    }

    /// An unmetered run reports `None`, not `0.0`.
    #[test]
    fn an_unmetered_run_reports_no_cost_rather_than_zero() {
        let mut b = SessionBudget::new(Some(100));
        b.record(&usage_with_parts(10_000, 500, 10_500));
        assert_eq!(b.spent_usd(), None);
        assert_eq!(b.max_usd(), None);
        assert!(!b.over_cost_ceiling(), "nothing to be over");
    }

    #[test]
    fn the_cost_ceiling_trips_once_spend_reaches_it() {
        // 100K prompt at $1/M plus 10K completion at $10/M = $0.20 a request.
        let mut b = capped(0.5);
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert!(!b.over_cost_ceiling(), "$0.20 of $0.50");
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert!(!b.over_cost_ceiling(), "$0.40 of $0.50");
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert!(b.over_cost_ceiling(), "$0.60 is past $0.50");
    }

    /// `0` is honest rather than a synonym for unbounded.
    #[test]
    fn a_zero_ceiling_stops_at_the_first_billed_request() {
        let mut b = capped(0.0);
        assert!(b.over_cost_ceiling());
        b.record(&usage_with_parts(10, 1, 11));
        assert!(b.over_cost_ceiling());
    }

    /// Cache shares come out of the prompt at their own rates.
    #[test]
    fn cache_shares_come_out_of_the_prompt_at_their_own_rates() {
        let r = TokenRates {
            prompt_usd: 10e-6,
            completion_usd: 0.0,
            cache_read_usd: Some(1e-6),
            cache_write_usd: Some(20e-6),
        };
        // 1000 prompt = 700 fresh + 200 read + 100 written.
        let cost = r.cost_usd(1000, 0, 200, 100);
        let expected = 700.0 * 10e-6 + 200.0 * 1e-6 + 100.0 * 20e-6;
        assert!((cost - expected).abs() < 1e-12, "{cost} != {expected}");
        // A share larger than the prompt cannot underflow the remainder.
        let _ = r.cost_usd(10, 0, 50, 50);
    }
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

    /// A verifier's cost counts toward the ceiling and leaves the worker's
    /// prompt-growth baseline alone (#131).
    #[test]
    fn a_side_request_is_charged_without_moving_the_baseline() {
        let mut budget = SessionBudget::new(Some(1200));
        budget.record(&usage_with_parts(1000, 50, 1050));
        assert_eq!(budget.charge(200), 1250);
        assert!(budget.exhausted());
        // The next worker turn is charged by its own growth, as before.
        assert_eq!(budget.record(&usage_with_parts(1100, 20, 1120)), 1250 + 20 + 100);
    }

    #[test]
    fn absent_usage_does_not_advance_spend() {
        let mut b = SessionBudget::new(Some(10));
        assert_eq!(b.record(&None), 0);
        assert!(!b.exhausted());
    }
}
