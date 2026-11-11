//! Turning records into the figures the page shows: by day, by model, by
//! agent, token types, cache hit rate and cost per million tokens.
//!
//! Cost is an API-equivalent estimate: tokens times a price somebody declared
//! (`prices.toml` or a price set on the page). A model with no price is
//! reported as unpriced, with its tokens still counted; it never adds a zero
//! to a total.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Duration, FixedOffset, NaiveDate};
use serde::{Deserialize, Serialize};

use super::{Agent, Record};
use crate::core::agent::spend::{self, Price};

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// Window in days ending today; 0 means everything recorded.
    #[serde(default)]
    pub days: u32,
    /// Empty means every agent.
    #[serde(default)]
    pub agents: Vec<Agent>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub messages: u64,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub total: u64,
    /// Cache reads as a share of all prompt tokens; `None` with no prompt tokens.
    pub cache_hit_rate: Option<f64>,
    /// Estimated dollars for the priced part; `None` when nothing here is priced.
    pub cost: Option<f64>,
    pub priced_tokens: u64,
    pub unpriced_tokens: u64,
    /// Estimated dollars per million tokens (all four kinds), priced part only.
    pub cost_per_mtok: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    pub agent: Agent,
    #[serde(flatten)]
    pub stats: Stats,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub agent: Agent,
    pub model: String,
    #[serde(flatten)]
    pub stats: Stats,
    pub priced: bool,
    /// Total tokens per day across the window, oldest first. Empty for Flint,
    /// whose figures come as one total per model.
    pub trend: Vec<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayRow {
    pub day: String,
    pub agent: Agent,
    #[serde(flatten)]
    pub stats: Stats,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub days: u32,
    pub totals: Stats,
    pub by_agent: Vec<AgentRow>,
    pub by_model: Vec<ModelRow>,
    pub by_day: Vec<DayRow>,
    pub unpriced_models: Vec<String>,
}

#[derive(Default, Clone)]
struct Sum {
    messages: u64,
    input: u64,
    cache_read: u64,
    cache_write: u64,
    output: u64,
    cost: f64,
    priced_tokens: u64,
    unpriced_tokens: u64,
    any_priced: bool,
}

impl Sum {
    fn tokens(&self) -> u64 {
        self.input + self.cache_read + self.cache_write + self.output
    }
    fn add(&mut self, o: &Sum) {
        self.messages += o.messages;
        self.input += o.input;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.output += o.output;
        self.cost += o.cost;
        self.priced_tokens += o.priced_tokens;
        self.unpriced_tokens += o.unpriced_tokens;
        self.any_priced |= o.any_priced;
    }
    fn stats(&self) -> Stats {
        let prompt = self.input + self.cache_read + self.cache_write;
        Stats {
            messages: self.messages,
            input: self.input,
            cache_read: self.cache_read,
            cache_write: self.cache_write,
            output: self.output,
            total: self.tokens(),
            cache_hit_rate: (prompt > 0).then(|| self.cache_read as f64 / prompt as f64),
            cost: self.any_priced.then_some(self.cost),
            priced_tokens: self.priced_tokens,
            unpriced_tokens: self.unpriced_tokens,
            cost_per_mtok: (self.any_priced && self.priced_tokens > 0)
                .then(|| self.cost / self.priced_tokens as f64 * 1_000_000.0),
        }
    }
}

fn day_of(ts: i64, tz: FixedOffset) -> Option<NaiveDate> {
    DateTime::from_timestamp_millis(ts).map(|d| d.with_timezone(&tz).date_naive())
}

/// Aggregate `records` for `query`. `prices` maps a model name to what it
/// costs; `now_ms` and `tz` decide which calendar day "today" is.
pub fn aggregate(
    records: &[Record],
    query: &Query,
    prices: &BTreeMap<String, Price>,
    now_ms: i64,
    tz: FixedOffset,
) -> Report {
    let today = day_of(now_ms, tz).unwrap_or_default();
    let span = if query.days == 0 { 30 } else { query.days };
    let cutoff = (query.days > 0).then(|| today - Duration::days(query.days as i64 - 1));
    let want = |a: Agent| query.agents.is_empty() || query.agents.contains(&a);

    // (day, agent, model) -> sums of tokens; priced afterwards per group.
    let mut groups: BTreeMap<(NaiveDate, Agent, String), Sum> = BTreeMap::new();
    for r in records {
        if !want(r.agent) {
            continue;
        }
        let Some(day) = day_of(r.ts, tz) else { continue };
        if cutoff.is_some_and(|c| day < c) {
            continue;
        }
        let s = groups.entry((day, r.agent, r.model.clone())).or_default();
        s.messages += 1;
        s.input += r.input;
        s.cache_read += r.cache_read;
        s.cache_write += r.cache_write;
        s.output += r.output;
    }
    for ((_, _, model), s) in groups.iter_mut() {
        match spend::price_for(prices, model) {
            Some(p) => {
                s.cost = spend::cost_usd(
                    &p,
                    model,
                    s.input + s.cache_read + s.cache_write,
                    s.cache_read,
                    s.cache_write,
                    s.output,
                );
                s.priced_tokens = s.tokens();
                s.any_priced = true;
            }
            None => s.unpriced_tokens = s.tokens(),
        }
    }

    // The trend window: `span` days ending today, or ending at the newest
    // record when everything is shown and that is further back.
    let first = cutoff.unwrap_or_else(|| today - Duration::days(span as i64 - 1));
    let mut total = Sum::default();
    let mut agents: BTreeMap<Agent, Sum> = BTreeMap::new();
    let mut models: BTreeMap<(Agent, String), (Sum, Vec<u64>)> = BTreeMap::new();
    let mut days: BTreeMap<(NaiveDate, Agent), Sum> = BTreeMap::new();
    for ((day, agent, model), s) in &groups {
        total.add(s);
        agents.entry(*agent).or_default().add(s);
        days.entry((*day, *agent)).or_default().add(s);
        let (m, trend) = models
            .entry((*agent, model.clone()))
            .or_insert_with(|| (Sum::default(), vec![0; span as usize]));
        m.add(s);
        let idx = (*day - first).num_days();
        if idx >= 0 && (idx as usize) < trend.len() {
            trend[idx as usize] += s.tokens();
        }
    }

    let unpriced: BTreeSet<String> = models
        .iter()
        .filter(|(_, (s, _))| !s.any_priced)
        .map(|((_, m), _)| m.clone())
        .collect();
    let mut by_model: Vec<ModelRow> = models
        .into_iter()
        .map(|((agent, model), (s, trend))| ModelRow {
            agent,
            priced: s.any_priced,
            model,
            stats: s.stats(),
            trend,
        })
        .collect();
    by_model.sort_by(|a, b| b.stats.total.cmp(&a.stats.total).then(a.model.cmp(&b.model)));

    Report {
        days: query.days,
        totals: total.stats(),
        by_agent: agents.into_iter().map(|(agent, s)| AgentRow { agent, stats: s.stats() }).collect(),
        by_model,
        by_day: days
            .into_iter()
            .map(|((day, agent), s)| DayRow { day: day.format("%Y-%m-%d").to_string(), agent, stats: s.stats() })
            .collect(),
        unpriced_models: unpriced.into_iter().collect(),
    }
}

/// Fold Flint's own recorded spend (one total per model, no per-day split)
/// into a report. Flint's counts include cache in `input_tokens`.
pub fn add_flint(report: &mut Report, flint: &spend::Report) {
    let mut sum = Sum::default();
    for m in &flint.by_model {
        let cache_read = m.cached_input_tokens.min(m.input_tokens);
        let cache_write = m.cache_write_tokens.min(m.input_tokens - cache_read);
        let s = Sum {
            messages: m.dispatches as u64,
            input: m.input_tokens - cache_read - cache_write,
            cache_read,
            cache_write,
            output: m.output_tokens,
            cost: m.cost.unwrap_or(0.0),
            priced_tokens: if m.cost.is_some() { m.input_tokens + m.output_tokens } else { 0 },
            unpriced_tokens: if m.cost.is_none() { m.input_tokens + m.output_tokens } else { 0 },
            any_priced: m.cost.is_some(),
        };
        sum.add(&s);
        report.by_model.push(ModelRow {
            agent: Agent::Flint,
            model: m.model.clone(),
            priced: s.any_priced,
            stats: s.stats(),
            trend: vec![],
        });
        if !s.any_priced && !report.unpriced_models.contains(&m.model) {
            report.unpriced_models.push(m.model.clone());
        }
    }
    if sum.messages == 0 {
        return;
    }
    report.by_agent.push(AgentRow { agent: Agent::Flint, stats: sum.stats() });
    // Re-derive the grand total from the agent rows, which are the whole truth.
    let mut grand = Sum::default();
    for a in &report.by_agent {
        let st = &a.stats;
        grand.add(&Sum {
            messages: st.messages,
            input: st.input,
            cache_read: st.cache_read,
            cache_write: st.cache_write,
            output: st.output,
            cost: st.cost.unwrap_or(0.0),
            priced_tokens: st.priced_tokens,
            unpriced_tokens: st.unpriced_tokens,
            any_priced: st.cost.is_some(),
        });
    }
    report.totals = grand.stats();
    report
        .by_model
        .sort_by(|a, b| b.stats.total.cmp(&a.stats.total).then(a.model.cmp(&b.model)));
    report.unpriced_models.sort();
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;
    // 2026-10-26T12:00:00Z
    const NOON: i64 = 1_793_016_000_000;

    fn rec(agent: Agent, model: &str, ts: i64, input: u64, cr: u64, cw: u64, out: u64) -> Record {
        Record {
            agent,
            ts,
            model: model.into(),
            session: "s".into(),
            project: "p".into(),
            input,
            cache_read: cr,
            cache_write: cw,
            output: out,
            id: String::new(),
        }
    }

    fn utc() -> FixedOffset {
        FixedOffset::east_opt(0).unwrap()
    }

    fn price(input: f64, output: f64) -> Price {
        Price { input, output, cached_input: Some(input / 10.0), cache_write: Some(input * 1.25) }
    }

    #[test]
    fn groups_by_agent_model_and_day_with_cache_rate_and_cost() {
        let recs = vec![
            rec(Agent::ClaudeCode, "claude-a", NOON, 100, 800, 100, 50),
            rec(Agent::ClaudeCode, "claude-a", NOON + DAY, 0, 0, 0, 10),
            rec(Agent::Codex, "gpt-x", NOON, 500, 500, 0, 0),
        ];
        let mut prices = BTreeMap::new();
        prices.insert("claude-a".to_string(), price(10.0, 20.0));
        let r = aggregate(&recs, &Query::default(), &prices, NOON + DAY, utc());

        assert_eq!(r.totals.messages, 3);
        assert_eq!(r.totals.total, 100 + 800 + 100 + 50 + 10 + 1000);
        assert_eq!(r.by_agent.len(), 2);
        assert_eq!(r.by_day.len(), 3);
        let claude = r.by_model.iter().find(|m| m.model == "claude-a").unwrap();
        assert_eq!(claude.stats.messages, 2);
        // prompt 1000, cache read 800.
        assert!((claude.stats.cache_hit_rate.unwrap() - 0.8).abs() < 1e-9);
        // (100*10 + 800*1 + 100*12.5 + 60*20) / 1e6
        let want = (1000.0 + 800.0 + 1250.0 + 1200.0) / 1e6;
        assert!((claude.stats.cost.unwrap() - want).abs() < 1e-12);
        assert!(claude.priced);
        assert_eq!(claude.trend.len(), 30);
        assert_eq!(claude.trend[29], 10);
        assert_eq!(claude.trend[28], 1050);
        // Unknown model: tokens counted, no cost, listed as unpriced.
        let gpt = r.by_model.iter().find(|m| m.model == "gpt-x").unwrap();
        assert!(!gpt.priced);
        assert_eq!(gpt.stats.cost, None);
        assert_eq!(gpt.stats.unpriced_tokens, 1000);
        assert_eq!(r.unpriced_models, vec!["gpt-x".to_string()]);
        // The total's cost covers only what is priced.
        assert!((r.totals.cost.unwrap() - want).abs() < 1e-12);
        assert_eq!(r.totals.unpriced_tokens, 1000);
        let per_m = want / 1060.0 * 1_000_000.0 + 0.0;
        assert!((r.totals.cost_per_mtok.unwrap() - per_m).abs() < 1e-6);
    }

    #[test]
    fn window_and_agent_filter_apply() {
        let recs = vec![
            rec(Agent::ClaudeCode, "m", NOON - 10 * DAY, 1, 0, 0, 1),
            rec(Agent::ClaudeCode, "m", NOON, 1, 0, 0, 1),
            rec(Agent::Codex, "m", NOON, 5, 0, 0, 5),
        ];
        let q = Query { days: 7, agents: vec![Agent::ClaudeCode] };
        let r = aggregate(&recs, &q, &BTreeMap::new(), NOON, utc());
        assert_eq!(r.totals.messages, 1);
        assert_eq!(r.by_model[0].trend.len(), 7);
        assert_eq!(r.totals.cost, None);
        let all = aggregate(&recs, &Query::default(), &BTreeMap::new(), NOON, utc());
        assert_eq!(all.totals.messages, 3);
    }

    #[test]
    fn empty_input_is_empty_report_without_division_by_zero() {
        let r = aggregate(&[], &Query::default(), &BTreeMap::new(), NOON, utc());
        assert_eq!(r.totals.cache_hit_rate, None);
        assert_eq!(r.totals.cost_per_mtok, None);
        assert!(r.by_model.is_empty());
    }

    #[test]
    fn flint_totals_fold_in() {
        let mut r = aggregate(
            &[rec(Agent::Codex, "gpt-x", NOON, 10, 0, 0, 5)],
            &Query::default(),
            &BTreeMap::new(),
            NOON,
            utc(),
        );
        let flint = spend::Report {
            since: None,
            by_model: vec![spend::ModelSpend {
                model: "local/q".into(),
                dispatches: 2,
                input_tokens: 100,
                cached_input_tokens: 40,
                cache_write_tokens: 0,
                output_tokens: 20,
                cost: Some(0.5),
                estimated_dispatches: 0,
            }],
            priced_cost: 0.5,
            unpriced_models: vec![],
            dispatches: 2,
            input_tokens: 100,
            output_tokens: 20,
            truncated: false,
            earliest: None,
        };
        add_flint(&mut r, &flint);
        let f = r.by_agent.iter().find(|a| a.agent == Agent::Flint).unwrap();
        assert_eq!((f.stats.input, f.stats.cache_read, f.stats.output), (60, 40, 20));
        assert_eq!(r.totals.messages, 3);
        assert_eq!(r.totals.cost, Some(0.5));
    }
}
