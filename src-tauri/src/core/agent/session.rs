//! Session-level budget caps for the agent loop. Tracks cumulative token usage
//! across turns and signals when a configured ceiling is reached.

use crate::core::agent::events::Usage;
use std::sync::{Arc, Mutex};

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

/// One run's spend as its subagents see it: the parent's own spend and every
/// in-process child's, against the parent's caps. A parent publishes its spend
/// here after each request; a child adds its own as it is billed. A child is
/// given the remainder when it starts, and every child also stops once the
/// aggregate reaches the parent's cap, so children running at the same time
/// cannot each spend the whole remainder: the overshoot is bounded by one
/// request per child in flight.
///
/// The spend pause (`[budget] pause_at_usd`) is the parent's alone: a child
/// never asks the user about spend; it stops at the ceiling and its answer
/// comes back with `finish_reason: "budget_exceeded"`.
#[derive(Debug)]
pub(crate) struct SpendLedger {
    max_tokens: Option<u64>,
    ceiling: Option<CostCeiling>,
    spend: Mutex<LedgerSpend>,
}

#[derive(Debug, Default, Clone, Copy)]
struct LedgerSpend {
    parent_tokens: u64,
    parent_usd: f64,
    child_tokens: u64,
    child_usd: f64,
}

impl SpendLedger {
    fn spend(&self) -> LedgerSpend {
        *self.spend.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn total_tokens(&self) -> u64 {
        let s = self.spend();
        s.parent_tokens.saturating_add(s.child_tokens)
    }

    fn total_usd(&self) -> f64 {
        let s = self.spend();
        s.parent_usd + s.child_usd
    }

    /// The parent's rates, when it meters money at all.
    pub(crate) fn rates(&self) -> Option<TokenRates> {
        self.ceiling.map(|c| c.rates)
    }

    /// Tokens left under the parent's cap (max minus everything spent so far).
    pub(crate) fn remaining_tokens(&self) -> Option<u64> {
        self.max_tokens
            .map(|max| max.saturating_sub(self.total_tokens()))
    }

    /// Dollars left under the parent's hard ceiling. `None` when there is no
    /// finite ceiling (no money meter, or one kept only for the pause).
    pub(crate) fn remaining_usd(&self) -> Option<f64> {
        let max = self.ceiling.map(|c| c.max_usd).filter(|m| m.is_finite())?;
        Some((max - self.total_usd()).max(0.0))
    }

    fn over_tokens(&self) -> bool {
        matches!(self.max_tokens, Some(max) if self.total_tokens() >= max)
    }

    fn over_usd(&self) -> bool {
        matches!(self.ceiling, Some(c) if self.total_usd() >= c.max_usd)
    }
}

#[derive(Debug, Default)]
pub(crate) struct SessionBudget {
    max_tokens: Option<u64>,
    spent_tokens: u64,
    last_total: u64,
    last_prompt: Option<u64>,
    /// The previous completion. The next prompt replays it, so it reappears as
    /// prompt growth and is not charged a second time.
    last_completion: u64,
    /// Whether any usage has been recorded yet. `last_prompt` being `None`
    /// is not the same thing: earlier requests may have reported only a total.
    recorded: bool,
    /// `None` leaves money unmetered, which is the default.
    ceiling: Option<CostCeiling>,
    spent_usd: f64,
    /// `[budget] pause_at_usd`: the spend at which the run asks, once, whether
    /// to go on. Metered by `ceiling`'s rates, so it does nothing without them.
    pause_at_usd: Option<f64>,
    /// The pause has been offered; it is never offered again in this run.
    paused: bool,
    /// The run-wide ledger shared with subagents, once there is one.
    ledger: Option<Arc<SpendLedger>>,
    /// This budget is a subagent's: it adds to the ledger rather than
    /// publishing the parent's spend to it.
    child: bool,
}

impl SessionBudget {
    pub(crate) fn new(max_tokens: Option<u64>) -> Self {
        Self {
            max_tokens,
            spent_tokens: 0,
            last_total: 0,
            last_prompt: None,
            last_completion: 0,
            recorded: false,
            ceiling: None,
            spent_usd: 0.0,
            pause_at_usd: None,
            paused: false,
            ledger: None,
            child: false,
        }
    }

    /// The ledger this run's subagents charge into, created on first use with
    /// this budget's caps. A parent's pause and ceiling then see its children's
    /// spend as well as its own.
    pub(crate) fn share(&mut self) -> Arc<SpendLedger> {
        if let Some(ledger) = &self.ledger {
            return ledger.clone();
        }
        let ledger = Arc::new(SpendLedger {
            max_tokens: self.max_tokens,
            ceiling: self.ceiling,
            spend: Mutex::new(LedgerSpend {
                parent_tokens: self.spent_tokens,
                parent_usd: self.spent_usd,
                ..Default::default()
            }),
        });
        self.ledger = Some(ledger.clone());
        self.child = false;
        ledger
    }

    /// Make this a subagent's budget, charging into its parent's `ledger`.
    /// A child never takes the spend pause; it stops at its own cap or once
    /// the run's aggregate reaches the parent's.
    pub(crate) fn join(mut self, ledger: Option<Arc<SpendLedger>>) -> Self {
        if ledger.is_some() {
            self.child = true;
            self.pause_at_usd = None;
        }
        self.ledger = ledger;
        self
    }

    /// Fold a change in this budget's own spend into the shared ledger.
    fn publish(&self, tokens: u64, usd: f64) {
        let Some(ledger) = &self.ledger else { return };
        let mut spend = ledger.spend.lock().unwrap_or_else(|e| e.into_inner());
        if self.child {
            spend.child_tokens = spend.child_tokens.saturating_add(tokens);
            spend.child_usd += usd;
        } else {
            spend.parent_tokens = self.spent_tokens;
            spend.parent_usd = self.spent_usd;
        }
    }

    /// What this run's subagents have spent, as seen by their parent.
    fn children(&self) -> (u64, f64) {
        match &self.ledger {
            Some(ledger) if !self.child => {
                let s = ledger.spend();
                (s.child_tokens, s.child_usd)
            }
            _ => (0, 0.0),
        }
    }

    /// Own spend plus, for a parent, its subagents'.
    fn total_usd(&self) -> f64 {
        self.spent_usd + self.children().1
    }

    /// Ask once when spend reaches `pause_at_usd`. `None` (or a value that is
    /// not a non-negative number) never pauses.
    pub(crate) fn with_pause_at(mut self, pause_at_usd: Option<f64>) -> Self {
        self.pause_at_usd = pause_at_usd.filter(|v| v.is_finite() && *v >= 0.0);
        self
    }

    /// The pause threshold, when spend has just reached it and it has not been
    /// offered yet. Returns it at most once per run: the caller asks, and the
    /// answer stands for the rest of the run.
    pub(crate) fn take_pause(&mut self) -> Option<f64> {
        let pause = self.pause_at_usd?;
        if self.child || self.paused || self.ceiling.is_none() || self.total_usd() < pause {
            return None;
        }
        self.paused = true;
        Some(pause)
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

        // A provider that reports prompt and completion but no total still
        // has a total: without it only completion tokens were charged and
        // prompt growth never reached the token ceiling.
        let reported_total = usage.total_tokens.or(match (usage.prompt_tokens, usage.completion_tokens) {
            (Some(prompt), Some(completion)) => Some(prompt.saturating_add(completion)),
            _ => None,
        });
        let delta = match reported_total {
            Some(total) => {
                let delta = match (
                    usage.prompt_tokens,
                    self.last_prompt,
                    usage.completion_tokens,
                ) {
                    (Some(prompt), Some(last_prompt), Some(completion)) => {
                        completion.saturating_add(
                            prompt
                                .saturating_sub(last_prompt)
                                .saturating_sub(self.last_completion),
                        )
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
        self.last_completion = usage.completion_tokens.unwrap_or(self.last_completion);
        self.recorded = true;
        self.spent_tokens = self.spent_tokens.saturating_add(delta);
        // Money is charged on the request as billed -- the whole prompt, every
        // time -- rather than on the marginal `delta` above: a provider bills
        // the whole prompt it is resent on every request.
        let mut usd = 0.0;
        if let Some(ceiling) = &self.ceiling {
            usd = ceiling.rates.cost_of(usage);
            self.spent_usd += usd;
        }
        self.publish(delta, usd);
        self.spent_tokens
    }

    /// USD charged so far, or `None` when this run meters no money at all --
    /// which is not the same as having spent nothing.
    pub(crate) fn spent_usd(&self) -> Option<f64> {
        self.ceiling.is_some().then(|| self.total_usd())
    }

    pub(crate) fn max_usd(&self) -> Option<f64> {
        self.ceiling.as_ref().map(|c| c.max_usd)
    }

    /// The hard ceiling, when there is one: a run metered only for its pause
    /// carries an infinite one, which is no ceiling at all.
    pub(crate) fn hard_max_usd(&self) -> Option<f64> {
        self.max_usd().filter(|max| max.is_finite())
    }

    /// True once the money ceiling is reached. This **stops the run**. Checked
    /// after a request rather than before, because a request's cost is not
    /// known until the provider reports its usage, so the overshoot is bounded
    /// by one request.
    pub(crate) fn over_cost_ceiling(&self) -> bool {
        matches!(self.ceiling, Some(c) if self.total_usd() >= c.max_usd)
            || (self.child && self.ledger.as_ref().is_some_and(|l| l.over_usd()))
    }

    /// Charge a side request's whole cost (the completion verifier's), which
    /// is not part of the conversation's prompt growth and so must not move
    /// the baselines `record` measures that growth from (#131).
    #[cfg(test)]
    pub(crate) fn charge(&mut self, tokens: u64) -> u64 {
        self.charge_priced(tokens, &[])
    }

    /// [`charge`](Self::charge), and the side requests' dollars at this run's
    /// rates, so a verifier's spend counts toward the pause and the ceiling.
    pub(crate) fn charge_priced(&mut self, tokens: u64, usages: &[Usage]) -> u64 {
        let usd = self
            .ceiling
            .map(|c| usages.iter().map(|u| c.rates.cost_of(u)).sum::<f64>())
            .unwrap_or(0.0);
        self.spent_tokens = self.spent_tokens.saturating_add(tokens);
        self.spent_usd += usd;
        self.publish(tokens, usd);
        self.spent_tokens
    }

    /// Own tokens plus, for a parent, its subagents'.
    pub(crate) fn spent(&self) -> u64 {
        self.spent_tokens.saturating_add(self.children().0)
    }

    /// True only when a ceiling is configured and has been reached or exceeded.
    pub(crate) fn exhausted(&self) -> bool {
        matches!(self.max_tokens, Some(max) if self.spent() >= max)
            || (self.child && self.ledger.as_ref().is_some_and(|l| l.over_tokens()))
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
    fn the_pause_is_offered_once_when_spend_reaches_it() {
        // $0.20 a request, pause at $0.30, hard ceiling at $1.
        let mut b = capped(1.0).with_pause_at(Some(0.3));
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert_eq!(b.take_pause(), None, "$0.20 is under the pause");
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert_eq!(b.take_pause(), Some(0.3), "$0.40 reached it");
        assert_eq!(b.take_pause(), None, "offered once");
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert_eq!(b.take_pause(), None, "still once");
        assert!(!b.over_cost_ceiling());
    }

    #[test]
    fn no_pause_without_a_threshold_or_without_rates() {
        let mut b = capped(1.0);
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert_eq!(b.take_pause(), None, "unset means today's behaviour");
        let mut b = SessionBudget::new(None).with_pause_at(Some(0.0));
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert_eq!(b.take_pause(), None, "nothing metered, nothing to pause on");
        let b = capped(1.0).with_pause_at(Some(-1.0));
        assert_eq!(b.pause_at_usd, None, "a negative threshold is ignored");
    }

    #[test]
    fn an_infinite_ceiling_is_no_hard_ceiling() {
        let mut b = capped(f64::INFINITY).with_pause_at(Some(0.1));
        b.record(&usage_with_parts(100_000, 10_000, 110_000));
        assert_eq!(b.hard_max_usd(), None);
        assert!(!b.over_cost_ceiling());
        assert_eq!(b.take_pause(), Some(0.1));
        assert_eq!(capped(2.0).hard_max_usd(), Some(2.0));
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

    /// A step's completion is part of the next step's prompt, so it must be
    /// charged once as completion and not again as prompt growth.
    #[test]
    fn a_replayed_completion_is_not_charged_twice() {
        let mut b = SessionBudget::new(None);
        assert_eq!(b.record(&usage_with_parts(10_000, 200, 10_200)), 10_200);
        // The prompt grew 400: 200 is last step's reply, 200 is new tool output.
        assert_eq!(b.record(&usage_with_parts(10_400, 300, 10_700)), 10_700);
    }

    /// Prompt and completion without a total are charged like the same
    /// counts with their total, not as completion tokens only.
    #[test]
    fn a_missing_total_is_derived_from_prompt_and_completion() {
        let parts = |p: u64, c: u64| {
            Some(Usage {
                prompt_tokens: Some(p),
                completion_tokens: Some(c),
                total_tokens: None,
                ..Default::default()
            })
        };
        let mut b = SessionBudget::new(None);
        assert_eq!(b.record(&parts(10_000, 200)), 10_200);
        assert_eq!(b.record(&parts(10_400, 300)), 10_700);
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
        // And the next request is charged by its prompt growth as usual, less
        // the 60 completion tokens the grown prompt replays (already charged).
        assert_eq!(budget.record(&usage_with_parts(1150, 40, 1190)), 1110 + 40 + 40);
    }

    /// A verifier's cost counts toward the ceiling and leaves the worker's
    /// prompt-growth baseline alone (#131).
    #[test]
    fn a_side_request_is_charged_without_moving_the_baseline() {
        let mut budget = SessionBudget::new(Some(1200));
        budget.record(&usage_with_parts(1000, 50, 1050));
        assert_eq!(budget.charge(200), 1250);
        assert!(budget.exhausted());
        // The next worker turn is charged by its own growth, as before, less
        // the 50 completion tokens the grown prompt replays.
        assert_eq!(budget.record(&usage_with_parts(1100, 20, 1120)), 1250 + 20 + 50);
    }


    /// A ledger shared by a parent run and the subagents it dispatches.
    fn parent_with_children(max_usd: f64, pause: Option<f64>) -> (SessionBudget, Arc<SpendLedger>) {
        let mut parent = capped(max_usd).with_pause_at(pause);
        let ledger = parent.share();
        (parent, ledger)
    }

    fn child_of(ledger: &Arc<SpendLedger>) -> SessionBudget {
        SessionBudget::new(ledger.remaining_tokens())
            .with_cost_ceiling(ledger.remaining_usd().map(|max_usd| CostCeiling {
                rates: ledger.rates().expect("rates"),
                max_usd,
            }))
            .join(Some(ledger.clone()))
    }

    /// $0.20 a request at `rates()`.
    fn twenty_cents() -> Option<Usage> {
        usage_with_parts(100_000, 10_000, 110_000)
    }

    #[test]
    fn a_childs_spend_counts_toward_the_parents_pause_and_ceiling() {
        let (mut parent, ledger) = parent_with_children(1.0, Some(0.5));
        parent.record(&twenty_cents());
        assert!((ledger.remaining_usd().unwrap() - 0.8).abs() < 1e-9, "max minus the parent's spend");
        let mut child = child_of(&ledger);
        child.record(&twenty_cents());
        child.record(&twenty_cents());
        assert!((parent.spent_usd().unwrap() - 0.6).abs() < 1e-9, "aggregate spend");
        assert_eq!(child.take_pause(), None, "a child never asks the user");
        assert_eq!(parent.take_pause(), Some(0.5), "the parent asks on the aggregate");
        child.record(&twenty_cents());
        child.record(&twenty_cents());
        assert!(child.over_cost_ceiling(), "the child stops at the remaining ceiling");
        assert!(parent.over_cost_ceiling(), "the parent sees the aggregate past $1");
    }

    #[test]
    fn parallel_children_stop_once_the_aggregate_reaches_the_ceiling() {
        let (_parent, ledger) = parent_with_children(1.0, None);
        let mut a = child_of(&ledger);
        let mut b = child_of(&ledger);
        assert_eq!(a.max_usd(), Some(1.0), "both were given the whole remainder");
        a.record(&twenty_cents());
        a.record(&twenty_cents());
        a.record(&twenty_cents());
        assert!(!a.over_cost_ceiling());
        b.record(&twenty_cents());
        assert!(!b.over_cost_ceiling(), "$0.80 together");
        b.record(&twenty_cents());
        assert!(a.over_cost_ceiling() && b.over_cost_ceiling(), "$1.00 together stops both");
    }

    #[test]
    fn a_childs_tokens_count_toward_the_parents_token_cap() {
        let mut parent = SessionBudget::new(Some(1_000));
        let ledger = parent.share();
        parent.record(&usage(Some(400)));
        assert_eq!(ledger.remaining_tokens(), Some(600), "max minus spent, not max");
        let mut child = SessionBudget::new(ledger.remaining_tokens()).join(Some(ledger.clone()));
        child.record(&usage(Some(300)));
        assert_eq!(parent.spent(), 700);
        assert!(!parent.exhausted());
        let mut other = SessionBudget::new(Some(600)).join(Some(ledger.clone()));
        other.record(&usage(Some(300)));
        assert!(parent.exhausted(), "1000 across the run");
        assert!(child.exhausted() && other.exhausted(), "every child stops on the aggregate");
    }

    /// A verifier's request costs dollars as well as tokens, so verifier
    /// retries reach the pause and the money ceiling.
    #[test]
    fn a_side_request_is_priced_toward_the_pause_and_the_ceiling() {
        let mut b = capped(0.5).with_pause_at(Some(0.3));
        b.record(&twenty_cents());
        let side = [twenty_cents().unwrap(), twenty_cents().unwrap()];
        assert_eq!(b.charge_priced(220_000, &side), 110_000 + 220_000);
        assert!((b.spent_usd().unwrap() - 0.6).abs() < 1e-9, "$0.20 + 2 x $0.20");
        assert_eq!(b.take_pause(), Some(0.3));
        assert!(b.over_cost_ceiling());
        // Unmetered: tokens only, as before.
        let mut plain = SessionBudget::new(None);
        plain.charge_priced(10, &side);
        assert_eq!(plain.spent_usd(), None);
        assert_eq!(plain.spent(), 10);
    }

    #[test]
    fn absent_usage_does_not_advance_spend() {
        let mut b = SessionBudget::new(Some(10));
        assert_eq!(b.record(&None), 0);
        assert!(!b.exhausted());
    }
}
