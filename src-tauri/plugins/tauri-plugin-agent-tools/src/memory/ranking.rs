//! Ranking memories by relevance, recency and use, under a token budget.
//!
//! The default retrieval order is the precedence chain (`record::rank`): who
//! said it, how specific, whether it is pinned, then the newest. That answers
//! "which record wins when two compete" but not "which record is worth the
//! room". With a small budget the second question decides what the model sees,
//! so this module orders the *usable* records by a blended score instead:
//!
//! ```text
//! score = 0.60 * relevance + 0.25 * recency + 0.15 * use
//! ```
//!
//! - **relevance**: the share of the request's distinctive words that the
//!   record (or its category) contains. `0` when there is no request text;
//! - **recency**: a half-life decay over the newest of created / updated /
//!   confirmed / last-used, so a fact the user confirmed last week beats one
//!   untouched for a year;
//! - **use**: how often the record has been injected before, log-scaled and
//!   capped so a record cannot win on habit alone.
//!
//! Ranking only *orders*. The filters in `retrieve::select` -- scope, expiry,
//! precedence, conflicts, duplicates -- run first and are not touched, so a
//! record that must not be seen is never rescued by a high score. Scope
//! specificity and pinning still come before the score (a pinned record is the
//! user saying "always"), and the precedence chain breaks every tie, so the
//! result is the same for any input order.

use std::cmp::Ordering;
use std::collections::HashSet;

use super::record::{prefer, MemoryRecord};

/// How a retrieval is ranked and bounded, when ranking is switched on.
#[derive(Debug, Clone, Copy, Default)]
pub struct Ranking<'a> {
    /// What the run is about (the user's request), for relevance. Empty ranks
    /// by recency and use alone.
    pub query: &'a str,
    /// Cap on injected memory in tokens. Combined with the character budget:
    /// whichever is smaller wins. `None` leaves only the character budget.
    pub max_tokens: Option<usize>,
}

/// Days for the recency score to halve.
const HALF_LIFE_DAYS: f64 = 30.0;
/// Uses at which the use score saturates.
const USE_SATURATION: f64 = 20.0;

const W_RELEVANCE: f64 = 0.60;
const W_RECENCY: f64 = 0.25;
const W_USE: f64 = 0.15;

/// The rough token cost of `chars` characters. Four characters a token: this
/// crate has no tokeniser, and the cap exists to bound the block, not to bill
/// it.
pub fn tokens_for_chars(chars: usize) -> usize {
    chars.div_ceil(4)
}

/// The character budget a token cap allows.
pub fn chars_for_tokens(tokens: usize) -> usize {
    tokens.saturating_mul(4)
}

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has",
    "how", "what", "when", "where", "which", "who", "why", "can", "could", "should", "would",
    "does", "did", "not", "you", "your", "our", "use", "using", "into", "about", "please",
    "make", "get", "all", "any", "out", "but", "its", "one",
];

/// The distinctive words of `text`: lowercase alphanumerics of three or more
/// characters, stopwords removed. A set, so a repeated word counts once.
fn terms(text: &str) -> HashSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3)
        .map(str::to_lowercase)
        .filter(|w| !STOPWORDS.contains(&w.as_str()))
        .collect()
}

/// Share of the query's terms found in the record, `0.0..=1.0`.
pub fn relevance(record: &MemoryRecord, query_terms: &HashSet<String>) -> f64 {
    if query_terms.is_empty() {
        return 0.0;
    }
    let mut mine = terms(&record.content);
    if let Some(category) = &record.category {
        mine.extend(terms(category));
    }
    let hits = query_terms.iter().filter(|t| mine.contains(*t)).count();
    hits as f64 / query_terms.len() as f64
}

/// Half-life decay over the newest timestamp the record carries.
pub fn recency(record: &MemoryRecord, now: i64) -> f64 {
    let newest = [
        Some(record.created_at),
        Some(record.updated_at),
        record.last_confirmed_at,
        record.last_used_at,
    ]
    .into_iter()
    .flatten()
    .max()
    .unwrap_or(record.created_at);
    let age_days = ((now - newest).max(0) as f64) / 86_400.0;
    0.5f64.powf(age_days / HALF_LIFE_DAYS)
}

/// Log-scaled use count, `0.0..=1.0`.
pub fn usage(record: &MemoryRecord) -> f64 {
    let n = f64::from(record.use_count);
    ((1.0 + n).ln() / (1.0 + USE_SATURATION).ln()).min(1.0)
}

/// The blended score for one record.
pub fn score(record: &MemoryRecord, query_terms: &HashSet<String>, now: i64) -> f64 {
    W_RELEVANCE * relevance(record, query_terms)
        + W_RECENCY * recency(record, now)
        + W_USE * usage(record)
}

/// Order `records` best first: scope specificity, then pinned, then score, then
/// the precedence chain as the tiebreak. Deterministic for any input order.
pub fn rank_by_score(records: &mut [MemoryRecord], query: &str, now: i64) {
    let query_terms = terms(query);
    let scored: std::collections::HashMap<String, f64> = records
        .iter()
        .map(|r| (r.id.as_str().to_string(), score(r, &query_terms, now)))
        .collect();
    records.sort_by(|a, b| {
        if a.id == b.id {
            return Ordering::Equal;
        }
        a.scope
            .specificity()
            .cmp(&b.scope.specificity())
            .then_with(|| b.pinned.cmp(&a.pinned))
            .then_with(|| {
                let sa = scored.get(a.id.as_str()).copied().unwrap_or(0.0);
                let sb = scored.get(b.id.as_str()).copied().unwrap_or(0.0);
                // Scores are finite by construction; `total_cmp` keeps the sort
                // total even if one ever were not.
                sb.total_cmp(&sa)
            })
            .then_with(|| {
                if prefer(a, b).0.id == a.id {
                    Ordering::Less
                } else {
                    Ordering::Greater
                }
            })
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::record::{Creator, MemoryId, Origin, Scope};
    use crate::memory::retrieve::{select, RetrievalContext};

    const NOW: i64 = 100 * 86_400;

    fn rec(id: &str, content: &str) -> MemoryRecord {
        let mut r = MemoryRecord::new(
            MemoryId::new(id),
            content,
            Scope::User,
            Creator::User,
            Origin::Explicit,
            NOW,
        );
        r.created_at = NOW;
        r.updated_at = NOW;
        r
    }

    fn ids(records: &[MemoryRecord]) -> Vec<&str> {
        records.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn a_relevant_old_record_beats_an_irrelevant_new_one() {
        let mut old = rec("old", "The deploy script lives in tools/deploy.ps1");
        old.created_at = 1;
        old.updated_at = 1;
        let new = rec("new", "Prefers tabs over spaces in markdown tables");
        let mut v = vec![new, old];
        rank_by_score(&mut v, "where is the deploy script", NOW);
        assert_eq!(ids(&v), ["old", "new"]);
    }

    #[test]
    fn with_no_query_the_newer_record_wins_on_recency() {
        let mut stale = rec("stale", "alpha beta gamma");
        stale.updated_at = NOW - 200 * 86_400;
        stale.created_at = stale.updated_at;
        let fresh = rec("fresh", "delta epsilon zeta");
        let mut v = vec![stale, fresh];
        rank_by_score(&mut v, "", NOW);
        assert_eq!(ids(&v), ["fresh", "stale"]);
    }

    #[test]
    fn use_count_breaks_a_recency_tie_but_cannot_beat_relevance() {
        let mut habit = rec("habit", "unrelated fact about colours");
        habit.use_count = 500;
        let relevant = rec("relevant", "the build runs with yarn workspaces");
        let mut v = vec![habit.clone(), relevant.clone()];
        rank_by_score(&mut v, "how does the build run", NOW);
        assert_eq!(ids(&v), ["relevant", "habit"]);

        let a = rec("a", "same age one");
        let mut b = rec("b", "same age two");
        b.use_count = 8;
        let mut v = vec![a, b];
        rank_by_score(&mut v, "", NOW);
        assert_eq!(ids(&v), ["b", "a"]);
    }

    #[test]
    fn use_saturates() {
        let mut r = rec("r", "x");
        r.use_count = 1_000_000;
        assert!((usage(&r) - 1.0).abs() < 1e-9);
        r.use_count = 0;
        assert_eq!(usage(&r), 0.0);
    }

    #[test]
    fn recency_halves_every_half_life() {
        let mut r = rec("r", "x");
        r.created_at = NOW - 30 * 86_400;
        r.updated_at = r.created_at;
        assert!((recency(&r, NOW) - 0.5).abs() < 1e-9);
        // A future timestamp is clamped, not rewarded.
        r.created_at = NOW + 5 * 86_400;
        r.updated_at = r.created_at;
        assert!((recency(&r, NOW) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn a_pinned_record_stays_ahead_within_its_scope_whatever_the_score() {
        let mut pinned = rec("pinned", "irrelevant colour preference");
        pinned.pinned = true;
        let hit = rec("hit", "the deploy script lives in tools");
        let mut v = vec![hit, pinned];
        rank_by_score(&mut v, "deploy script", NOW);
        assert_eq!(ids(&v), ["pinned", "hit"]);
    }

    #[test]
    fn scope_chain_still_comes_first() {
        let user = rec("user", "irrelevant colour preference");
        let mut project = rec("project", "the deploy script lives in tools");
        project.scope = Scope::Project;
        let mut v = vec![project, user];
        rank_by_score(&mut v, "deploy script", NOW);
        assert_eq!(ids(&v), ["user", "project"]);
    }

    #[test]
    fn the_order_does_not_depend_on_input_order() {
        let base: Vec<MemoryRecord> = (0..6)
            .map(|i| {
                let mut r = rec(&format!("m{i}"), &format!("fact number {i} about deploy"));
                r.use_count = (i % 3) as u32;
                r.updated_at = NOW - i as i64 * 86_400;
                r
            })
            .collect();
        let mut forward = base.clone();
        let mut backward: Vec<MemoryRecord> = base.into_iter().rev().collect();
        rank_by_score(&mut forward, "deploy facts", NOW);
        rank_by_score(&mut backward, "deploy facts", NOW);
        assert_eq!(ids(&forward), ids(&backward));
    }

    #[test]
    fn token_conversion_rounds_up_and_inverts_closely() {
        assert_eq!(tokens_for_chars(0), 0);
        assert_eq!(tokens_for_chars(1), 1);
        assert_eq!(tokens_for_chars(8), 2);
        assert_eq!(chars_for_tokens(3), 12);
    }

    fn ctx<'a>(ranking: Option<Ranking<'a>>, budget_chars: usize) -> RetrievalContext<'a> {
        RetrievalContext { now: NOW, budget_chars, ranking, ..Default::default() }
    }

    #[test]
    fn select_with_ranking_keeps_the_relevant_record_under_a_tight_token_budget() {
        let records = vec![
            rec("a", "Prefers dark mode in every editor window"),
            rec("b", "The release pipeline publishes installers from the main branch"),
            rec("c", "Lunch is at noon on fridays"),
        ];
        // Room for exactly one of the three (each is well over 10 tokens apart
        // from the small one), so ranking decides which survives.
        let one = tokens_for_chars("The release pipeline publishes installers from the main branch".len() + 1);
        let sel = select(
            &records,
            &ctx(Some(Ranking { query: "how does the release pipeline publish installers", max_tokens: Some(one) }), 10_000),
        );
        let got: Vec<&str> = sel.injected.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(got, ["b"]);
        assert_eq!(sel.dropped_for_budget.len(), 2);
        assert!(tokens_for_chars(sel.chars_used) <= one);
    }

    #[test]
    fn select_without_ranking_is_unchanged() {
        let records = vec![rec("a", "first"), rec("b", "second")];
        let plain = select(&records, &ctx(None, 10_000));
        assert_eq!(plain.injected.len(), 2);
    }

    #[test]
    fn ranking_never_rescues_a_record_the_filters_removed() {
        let mut expired = rec("gone", "the deploy script lives in tools");
        expired.expires_at = Some(NOW - 1);
        let records = vec![expired, rec("kept", "something else entirely here")];
        let sel = select(&records, &ctx(Some(Ranking { query: "deploy script", max_tokens: None }), 10_000));
        let got: Vec<&str> = sel.injected.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(got, ["kept"]);
    }

    #[test]
    fn a_zero_token_budget_injects_nothing() {
        let records = vec![rec("a", "anything at all")];
        let sel = select(&records, &ctx(Some(Ranking { query: "", max_tokens: Some(0) }), 10_000));
        assert!(sel.injected.is_empty());
    }
}
