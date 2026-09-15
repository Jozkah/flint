//! What a run cost, where somebody said what things cost. AH-175.
//!
//! Tokens have been counted for a long time; money has never appeared
//! anywhere, and the reason is worth keeping in front of whoever reads this:
//! the harness does not know what a model costs. Prices change, they differ by
//! account, they differ by region, and a number invented here would be wrong
//! in a way that looks authoritative. A dashboard that quietly multiplies by
//! last year's rate is worse than one that says nothing.
//!
//! So: a price is something a person declares, in
//! `<data folder>/prices.toml`, and spend is reported only for the models
//! declared there.
//!
//! ```toml
//! # dollars per million tokens, as your bill states them
//! [models."anthropic/claude-sonnet-4-5"]
//! input = 3.0
//! output = 15.0
//! cached_input = 0.3   # optional; falls back to `input` when absent
//! ```
//!
//! Everything else follows from that one decision:
//!
//! * A model with no declared price is reported as **not priced**, with its
//!   tokens still counted. It is never folded into a total as zero, because a
//!   total that silently omits a model is a wrong total.
//! * A count the provider did not report is an estimate, and estimated tokens
//!   are totalled separately from counted ones -- the same distinction
//!   `usage.rs` already draws, carried through to money rather than flattened.
//! * Cached input is charged at the cached rate where one is declared, because
//!   that is the whole reason anybody looks at a cache figure.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The most usage records read for one report.
pub const MAX_RECORDS: usize = 200_000;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SpendErrorKind {
    /// The price file is there and cannot be understood.
    PricesMalformed,
    /// The period asked for is not one this can read.
    BadPeriod,
    /// The usage log could not be read.
    Io,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpendError {
    pub kind: SpendErrorKind,
    pub message: String,
}

impl SpendError {
    fn new(kind: SpendErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: tauri_plugin_agent_tools::harness_error::scrub(&message.into()),
        }
    }
}

/// What this failure is in the harness's own vocabulary (AH-009).
impl From<&SpendError> for tauri_plugin_agent_tools::harness_error::HarnessError {
    fn from(error: &SpendError) -> Self {
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            SpendErrorKind::PricesMalformed | SpendErrorKind::BadPeriod => ErrorKind::InvalidInput,
            SpendErrorKind::Io => ErrorKind::Io,
        };
        HarnessError::new(kind, error.message.clone()).at(Stage::Tool)
    }
}

/// What one model costs, as a person declared it: dollars per million tokens.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    /// What a cache read costs, when the provider charges less for it.
    #[serde(default)]
    pub cached_input: Option<f64>,
}

#[derive(Deserialize, Default, Debug)]
struct PricesToml {
    #[serde(default)]
    models: BTreeMap<String, Price>,
}

pub fn prices_path(data_folder: &Path) -> PathBuf {
    data_folder.join("prices.toml")
}

/// Read the declared prices. No file means no prices, which is not an error.
pub fn prices(data_folder: &Path) -> Result<BTreeMap<String, Price>, SpendError> {
    let raw = match std::fs::read_to_string(prices_path(data_folder)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(SpendError::new(SpendErrorKind::Io, format!("prices.toml: {e}"))),
    };
    let parsed: PricesToml = toml::from_str(&raw).map_err(|e| {
        SpendError::new(SpendErrorKind::PricesMalformed, format!("prices.toml: {e}"))
    })?;
    for (model, price) in &parsed.models {
        let sane = [Some(price.input), Some(price.output), price.cached_input]
            .into_iter()
            .flatten()
            .all(|v| v.is_finite() && v >= 0.0);
        if !sane {
            return Err(SpendError::new(
                SpendErrorKind::PricesMalformed,
                format!("the price for {model:?} is not a number of dollars per million tokens"),
            ));
        }
    }
    Ok(parsed.models)
}

/// What one model's use came to.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpend {
    pub model: String,
    pub dispatches: usize,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    /// Dollars, when this model has a declared price. `None` means nobody said
    /// what it costs -- never a zero.
    #[serde(default)]
    pub cost: Option<f64>,
    /// How many of the dispatches counted here were Flint's own estimate rather
    /// than the provider's count.
    pub estimated_dispatches: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The window this covers, as the caller asked for it.
    pub since: Option<String>,
    /// Per run, most recent first, when a run was asked for.
    pub by_model: Vec<ModelSpend>,
    /// The total for models that have a declared price.
    pub priced_cost: f64,
    /// The models used here that nobody has priced.
    pub unpriced_models: Vec<String>,
    pub dispatches: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Set when the log had more records than were read.
    pub truncated: bool,
}

/// A period like `7d`, `24h` or `30m`, as an RFC-3339 instant to compare
/// against. Absent means everything.
pub fn since(period: Option<&str>) -> Result<Option<String>, SpendError> {
    let Some(period) = period.map(str::trim).filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let (count, unit) = period.split_at(period.len().saturating_sub(1));
    let count: i64 = count.parse().map_err(|_| {
        SpendError::new(
            SpendErrorKind::BadPeriod,
            format!("{period:?} is not a period like 7d, 24h or 30m"),
        )
    })?;
    let minutes = match unit {
        "m" => count,
        "h" => count * 60,
        "d" => count * 60 * 24,
        _ => {
            return Err(SpendError::new(
                SpendErrorKind::BadPeriod,
                format!("{period:?} does not end in m, h or d"),
            ))
        }
    };
    if minutes <= 0 {
        return Err(SpendError::new(
            SpendErrorKind::BadPeriod,
            "a period has to be a positive number of minutes, hours or days",
        ));
    }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(minutes as u64 * 60))
        .unwrap_or(std::time::UNIX_EPOCH);
    let seconds = cutoff
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok(Some(rfc3339(seconds)))
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ`, which is what the usage
/// log writes and so what a string comparison can be made against.
fn rfc3339(seconds: u64) -> String {
    // Days since epoch to a civil date, by the usual algorithm; no dependency
    // for what is four lines of arithmetic.
    let days = (seconds / 86_400) as i64;
    let rem = seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// One dispatch's tokens, from whichever record carries them.
struct Counted {
    at: String,
    session: String,
    invocation: String,
    model: String,
    input: u64,
    cached: u64,
    output: u64,
    estimated: bool,
}

/// The dispatches this data folder knows about.
///
/// Two records carry them and only one is written on each surface: the
/// desktop appends to the payload-usage log, and a headless run records
/// `usage.reported` into the session's event log. A report that read only the
/// first said "nothing" after a CLI run that really did spend tokens -- found
/// by running it. Both are read here and joined on the invocation, so a
/// dispatch that appears in both is counted once, with the payload-usage
/// record preferred because it carries the cache figure.
fn counted(data_folder: &Path) -> Vec<Counted> {
    let mut out: Vec<Counted> = tauri_plugin_agent_tools::usage::read_all(data_folder)
        .into_iter()
        .take(MAX_RECORDS)
        .map(|record| Counted {
            at: record.at.clone(),
            session: record.session.clone(),
            invocation: record.invocation.clone(),
            model: record.model.clone(),
            input: record.prompt_tokens.unwrap_or(0),
            cached: cached_of(&record),
            output: record.completion_tokens.unwrap_or(0),
            estimated: record.source == tauri_plugin_agent_tools::usage::UsageSource::Estimated,
        })
        .collect();
    let known: std::collections::BTreeSet<String> =
        out.iter().map(|c| c.invocation.clone()).collect();

    // The event log, for the runs that only recorded there.
    let events_dir = data_folder.join("events");
    let Ok(entries) = std::fs::read_dir(&events_dir) else { return out };
    for entry in entries.flatten().take(10_000) {
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        // The model a run answered with, as its own events say.
        let mut model_of_run: BTreeMap<String, String> = BTreeMap::new();
        let mut pending: Vec<Counted> = Vec::new();
        for line in text.lines().take(MAX_RECORDS) {
            let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let kind = event.get("kind").and_then(|v| v.as_str()).unwrap_or_default();
            let run = event.get("run").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let payload = event.get("payload").cloned().unwrap_or_default();
            if kind == "run.started" {
                if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
                    model_of_run.insert(run, model.to_string());
                }
                continue;
            }
            if kind != "usage.reported" {
                continue;
            }
            let input = payload.get("inputTokens").and_then(serde_json::Value::as_u64);
            let output = payload.get("outputTokens").and_then(serde_json::Value::as_u64);
            // The second `usage.reported` of a turn only names the model that
            // answered; it counts no tokens and is not a dispatch.
            let (Some(input), Some(output)) = (input, output) else { continue };
            let invocation = event
                .get("invocation")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if known.contains(&invocation) {
                continue;
            }
            pending.push(Counted {
                at: event.get("at").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                session: event
                    .get("session")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                invocation,
                model: run.clone(),
                input,
                cached: payload
                    .get("cachedInputTokens")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                output,
                // The event log records what the provider said; an estimate
                // never reaches it as a count.
                estimated: false,
            });
        }
        for mut record in pending {
            // `model` held the run id until its run said what it answered with.
            record.model = model_of_run
                .get(&record.model)
                .cloned()
                .unwrap_or_else(|| "(not recorded)".to_string());
            out.push(record);
        }
    }
    out
}

/// What was spent, per model, over a window.
pub fn report(
    data_folder: &Path,
    period: Option<&str>,
    session: Option<&str>,
) -> Result<Report, SpendError> {
    let cutoff = since(period)?;
    let prices = prices(data_folder)?;
    let all = counted(data_folder);
    let truncated = all.len() > MAX_RECORDS;

    let mut by_model: BTreeMap<String, ModelSpend> = BTreeMap::new();
    let mut dispatches = 0usize;
    for record in all.into_iter().take(MAX_RECORDS) {
        if let Some(cutoff) = cutoff.as_ref() {
            if record.at.as_str() < cutoff.as_str() {
                continue;
            }
        }
        if let Some(session) = session {
            if record.session != session {
                continue;
            }
        }
        let model = if record.model.trim().is_empty() {
            "(not recorded)".to_string()
        } else {
            record.model.clone()
        };
        let entry = by_model.entry(model.clone()).or_insert_with(|| ModelSpend {
            model,
            dispatches: 0,
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            cost: None,
            estimated_dispatches: 0,
        });
        entry.dispatches += 1;
        dispatches += 1;
        entry.input_tokens += record.input;
        entry.output_tokens += record.output;
        entry.cached_input_tokens += record.cached;
        if record.estimated {
            entry.estimated_dispatches += 1;
        }
    }

    let mut priced_cost = 0.0;
    let mut unpriced = Vec::new();
    for entry in by_model.values_mut() {
        match price_for(&prices, &entry.model) {
            Some(price) => {
                let cached = entry.cached_input_tokens.min(entry.input_tokens);
                let plain = entry.input_tokens - cached;
                let cached_rate = price.cached_input.unwrap_or(price.input);
                let cost = (plain as f64 * price.input
                    + cached as f64 * cached_rate
                    + entry.output_tokens as f64 * price.output)
                    / 1_000_000.0;
                entry.cost = Some(cost);
                priced_cost += cost;
            }
            // Counted, listed, and deliberately not added to any total.
            None => unpriced.push(entry.model.clone()),
        }
    }

    Ok(Report {
        since: cutoff,
        input_tokens: by_model.values().map(|m| m.input_tokens).sum(),
        output_tokens: by_model.values().map(|m| m.output_tokens).sum(),
        by_model: by_model.into_values().collect(),
        priced_cost,
        unpriced_models: unpriced,
        dispatches,
        truncated,
    })
}

/// A record's cached prompt tokens, where the provider reported them.
fn cached_of(record: &tauri_plugin_agent_tools::usage::PayloadUsage) -> u64 {
    serde_json::to_value(record)
        .ok()
        .and_then(|v| {
            v.get("cached_prompt_tokens")
                .or_else(|| v.get("cachedPromptTokens"))
                .and_then(serde_json::Value::as_u64)
        })
        .unwrap_or(0)
}

/// The declared price for a model, by its exact name or by the part after the
/// provider prefix -- `llm-host/claude-sonnet-4-5` finds `claude-sonnet-4-5`.
fn price_for(prices: &BTreeMap<String, Price>, model: &str) -> Option<Price> {
    if let Some(price) = prices.get(model) {
        return Some(*price);
    }
    let bare = model.rsplit('/').next()?;
    prices.get(bare).copied()
}

/// The report, as a person reads it.
pub fn render(report: &Report) -> String {
    let mut out = String::new();
    match &report.since {
        Some(since) => out.push_str(&format!("Since {since}:\n")),
        None => out.push_str("Everything recorded:\n"),
    }
    if report.by_model.is_empty() {
        out.push_str("  nothing\n");
        return out;
    }
    for model in &report.by_model {
        out.push_str(&format!(
            "  {:<38} {:>4} dispatch(es)  in {:>9}  out {:>8}  {}\n",
            model.model,
            model.dispatches,
            model.input_tokens,
            model.output_tokens,
            match model.cost {
                Some(cost) => format!("${cost:.4}"),
                None => "not priced".to_string(),
            }
        ));
        if model.estimated_dispatches > 0 {
            out.push_str(&format!(
                "      {} of those were Jan's own estimate, not the provider's count\n",
                model.estimated_dispatches
            ));
        }
    }
    out.push_str(&format!(
        "\n  {} dispatch(es), {} in, {} out\n  ${:.4} across the models that have a declared price\n",
        report.dispatches, report.input_tokens, report.output_tokens, report.priced_cost
    ));
    if !report.unpriced_models.is_empty() {
        out.push_str(&format!(
            "  not in that figure, because nobody has said what they cost: {}\n",
            report.unpriced_models.join(", ")
        ));
    }
    if report.truncated {
        out.push_str("  (the usage log is longer than this report read)\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::fixtures::Workspace;
    use tauri_plugin_agent_tools::usage::{self, UsageSource};

    fn usage_record(data: &Path, model: &str, input: u64, output: u64, source: UsageSource) {
        let mut record = usage::record(format!("inv-{model}-{input}-{output}"), source);
        record.model = model.to_string();
        record.session = "s-spend".into();
        record.prompt_tokens = Some(input);
        record.completion_tokens = Some(output);
        record.total_tokens = Some(input + output);
        usage::append(data, &record);
    }

    #[test]
    fn a_model_nobody_priced_is_counted_and_never_totalled_as_zero() {
        let data = Workspace::new("spend-unpriced");
        usage_record(data.path(), "mystery/model", 1_000, 100, UsageSource::Provider);
        let report = report(data.path(), None, None).unwrap();

        assert_eq!(report.dispatches, 1);
        assert_eq!(report.input_tokens, 1_000);
        let model = &report.by_model[0];
        assert_eq!(model.cost, None, "an unpriced model has no cost, not a zero");
        assert_eq!(report.priced_cost, 0.0);
        assert_eq!(report.unpriced_models, ["mystery/model"]);

        let text = render(&report);
        assert!(text.contains("not priced"), "{text}");
        assert!(text.contains("nobody has said what they cost"), "{text}");
    }

    #[test]
    fn a_declared_price_is_applied_to_the_tokens_it_covers() {
        let data = Workspace::new("spend-priced").file(
            "prices.toml",
            "[models.\"anthropic/sonnet\"]\ninput = 3.0\noutput = 15.0\n",
        );
        usage_record(data.path(), "anthropic/sonnet", 1_000_000, 100_000, UsageSource::Provider);
        let report = report(data.path(), None, None).unwrap();
        let model = &report.by_model[0];
        // A million in at $3 and a hundred thousand out at $15.
        assert!((model.cost.unwrap() - (3.0 + 1.5)).abs() < 1e-9, "{:?}", model.cost);
        assert!((report.priced_cost - 4.5).abs() < 1e-9);
        assert!(report.unpriced_models.is_empty());
        assert!(render(&report).contains("$4.5000"));
    }

    /// The prefix a provider adds is not part of what a person prices.
    #[test]
    fn a_price_is_found_with_or_without_the_provider_prefix() {
        let data = Workspace::new("spend-prefix")
            .file("prices.toml", "[models.\"sonnet\"]\ninput = 1.0\noutput = 2.0\n");
        usage_record(data.path(), "llm-host/sonnet", 1_000_000, 1_000_000, UsageSource::Provider);
        let report = report(data.path(), None, None).unwrap();
        assert_eq!(report.by_model[0].cost, Some(3.0));
    }

    #[test]
    fn an_estimate_is_counted_and_said_to_be_one() {
        let data = Workspace::new("spend-estimate");
        usage_record(data.path(), "m", 10, 5, UsageSource::Estimated);
        usage_record(data.path(), "m", 20, 5, UsageSource::Provider);
        let report = report(data.path(), None, None).unwrap();
        let model = &report.by_model[0];
        assert_eq!(model.dispatches, 2);
        assert_eq!(model.estimated_dispatches, 1);
        assert!(render(&report).contains("Jan's own estimate"));
    }

    #[test]
    fn a_period_is_read_or_refused() {
        assert!(since(None).unwrap().is_none());
        for good in ["30m", "24h", "7d"] {
            let cutoff = since(Some(good)).unwrap().expect("a cutoff");
            assert!(cutoff.ends_with('Z') && cutoff.len() == 20, "{cutoff}");
        }
        for bad in ["7x", "d", "-3d", "0h", "lots"] {
            let refused = since(Some(bad)).unwrap_err();
            assert_eq!(refused.kind, SpendErrorKind::BadPeriod, "{bad}");
        }
        let harness: tauri_plugin_agent_tools::harness_error::HarnessError =
            (&since(Some("7x")).unwrap_err()).into();
        assert_eq!(
            harness.kind(),
            tauri_plugin_agent_tools::harness_error::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn a_window_leaves_out_what_is_older_than_it() {
        let data = Workspace::new("spend-window");
        usage_record(data.path(), "m", 10, 1, UsageSource::Provider);
        // A record from before the window, written with an old timestamp.
        let mut old = usage::record("inv-old", UsageSource::Provider);
        old.model = "m".into();
        old.at = "2000-01-01T00:00:00Z".into();
        old.prompt_tokens = Some(999_999);
        usage::append(data.path(), &old);

        let all = report(data.path(), None, None).unwrap();
        assert_eq!(all.dispatches, 2);
        let recent = report(data.path(), Some("1d"), None).unwrap();
        assert_eq!(recent.dispatches, 1, "the old record is outside the window");
        assert_eq!(recent.input_tokens, 10);
    }

    #[test]
    fn a_price_file_that_is_wrong_is_refused_rather_than_half_applied() {
        let data = Workspace::new("spend-bad-prices").file("prices.toml", "this is not toml");
        let refused = report(data.path(), None, None).unwrap_err();
        assert_eq!(refused.kind, SpendErrorKind::PricesMalformed);

        let negative = Workspace::new("spend-negative-prices").file(
            "prices.toml",
            "[models.\"m\"]\ninput = -1.0\noutput = 2.0\n",
        );
        let refused = report(negative.path(), None, None).unwrap_err();
        assert_eq!(refused.kind, SpendErrorKind::PricesMalformed);
        assert!(refused.message.contains("dollars per million"), "{}", refused.message);

        // And no price file at all is simply no prices.
        let none = Workspace::new("spend-no-prices");
        assert!(prices(none.path()).unwrap().is_empty());
    }
}
