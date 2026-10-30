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
//! cache_read = 0.3     # optional (alias `cached_input`); cached prompt reads
//! cache_write = 3.75   # optional; prompt tokens written to the cache
//! ```
//!
//! When `cache_read` / `cache_write` are absent they are not invented, with one
//! exception: for the Claude family Anthropic's published ratios apply (read =
//! 0.1x input, write = 1.25x input, the 5-minute cache). Any other model's
//! cached tokens are priced at the normal `input` rate.
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
    /// `cache_read` in prices.toml is the preferred spelling.
    #[serde(default, alias = "cache_read")]
    pub cached_input: Option<f64>,
    /// What writing prompt tokens to the cache costs, when it differs.
    #[serde(default)]
    pub cache_write: Option<f64>,
}

/// Whether a model name is in the Claude family, whose cache ratios Anthropic
/// publishes. Matched on the part after any provider prefix.
pub(crate) fn is_claude_family(model: &str) -> bool {
    let bare = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
    ["claude", "sonnet", "opus", "haiku"].iter().any(|m| bare.contains(m))
}

impl Price {
    /// `(cache_read, cache_write)` in dollars per million, with the family
    /// defaults described in the module docs where nothing was declared.
    pub fn cache_rates(&self, model: &str) -> (f64, f64) {
        let claude = is_claude_family(model);
        let read = self
            .cached_input
            .unwrap_or(if claude { self.input * 0.1 } else { self.input });
        let write = self
            .cache_write
            .unwrap_or(if claude { self.input * 1.25 } else { self.input });
        (read, write)
    }
}

/// Dollars for token counts at `price`. `cached` and `written` are **shares of
/// `input`** (the prompt total, cache included). Providers that report the
/// prompt total including cache (OpenAI, DeepSeek, and genai's normalized
/// Anthropic count) are passed straight in; Anthropic's native
/// `input_tokens` excludes both, so the caller adds them first
/// (`events::Usage::from_completion` does). Clamped so a count that
/// disagrees with the total cannot go negative.
pub fn cost_usd(
    price: &Price,
    model: &str,
    input: u64,
    cached: u64,
    written: u64,
    output: u64,
) -> f64 {
    let cached = cached.min(input);
    let written = written.min(input - cached);
    let plain = input - cached - written;
    let (read_rate, write_rate) = price.cache_rates(model);
    (plain as f64 * price.input
        + cached as f64 * read_rate
        + written as f64 * write_rate
        + output as f64 * price.output)
        / 1_000_000.0
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
        let sane = [Some(price.input), Some(price.output), price.cached_input, price.cache_write]
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
    /// Prompt tokens written to the provider's cache (part of `input_tokens`).
    #[serde(default)]
    pub cache_write_tokens: u64,
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
    /// When the oldest dispatch in the window happened, in seconds since the
    /// epoch. A rolling window frees up when this one ages out.
    pub earliest: Option<u64>,
}

/// A period like `7d`, `24h` or `30m`, as an RFC-3339 instant to compare
/// against. Absent means everything.
pub fn since(period: Option<&str>) -> Result<Option<String>, SpendError> {
    let Some(period) = period.map(str::trim).filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    // Split on the last character, not the last byte: a non-ASCII unit
    // would otherwise panic on a char boundary.
    let split = period.char_indices().last().map(|(i, _)| i).unwrap_or(0);
    let (count, unit) = period.split_at(split);
    let count: i64 = count.parse().map_err(|_| {
        SpendError::new(
            SpendErrorKind::BadPeriod,
            format!("{period:?} is not a period like 7d, 24h or 30m"),
        )
    })?;
    let minutes = match unit {
        "m" => count,
        "h" => count.checked_mul(60).unwrap_or(i64::MAX),
        "d" => count.checked_mul(60 * 24).unwrap_or(i64::MAX),
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
        .checked_sub(std::time::Duration::from_secs((minutes as u64).saturating_mul(60)))
        .unwrap_or(std::time::UNIX_EPOCH);
    let seconds = cutoff
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok(Some(rfc3339(seconds)))
}

/// An instant as `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Only the local API server's usage meter calls this, and the `cli` build has no
/// server, so it would be dead code (an error under `-D warnings`) there.
#[cfg(not(feature = "cli"))]
pub(crate) fn rfc3339_of(at: std::time::SystemTime) -> String {
    rfc3339(at.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
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

/// Seconds since the epoch for a `YYYY-MM-DDTHH:MM:SS` instant, the inverse of
/// `rfc3339`. Fractions and a trailing zone are ignored; the log writes UTC.
pub(crate) fn epoch_of(at: &str) -> Option<u64> {
    let digits = |from: usize, len: usize| -> Option<i64> { at.get(from..from + len)?.parse().ok() };
    let (y, m, d) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    let (hh, mm, ss) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
}

/// One dispatch's tokens, from whichever record carries them.
#[derive(Clone)]
struct Counted {
    at: String,
    session: String,
    invocation: String,
    model: String,
    input: u64,
    cached: u64,
    cache_write: u64,
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
    let mut out = usage_log_counted(data_folder);
    let known: std::collections::BTreeSet<String> =
        out.iter().map(|c| c.invocation.clone()).collect();
    counted_rest(data_folder, &mut out, &known);
    out
}

/// The payload-usage log, parsed once per change of its size or mtime: the
/// quota check runs every turn and the log only grows (CAGC-026).
fn usage_log_counted(data_folder: &Path) -> Vec<Counted> {
    type Key = (std::path::PathBuf, std::time::SystemTime, u64);
    static CACHE: std::sync::Mutex<Option<(Key, Vec<Counted>)>> = std::sync::Mutex::new(None);
    let path = tauri_plugin_agent_tools::usage::log_path(data_folder);
    let key: Option<Key> = std::fs::metadata(&path)
        .ok()
        .and_then(|m| Some((path.clone(), m.modified().ok()?, m.len())));
    if let Some(key) = &key {
        if let Ok(cache) = CACHE.lock() {
            if let Some((k, records)) = cache.as_ref() {
                if k == key {
                    return records.clone();
                }
            }
        }
    }
    let fresh: Vec<Counted> = tauri_plugin_agent_tools::usage::read_all(data_folder)
        .into_iter()
        // One past the cap, so a report can tell it was cut short.
        .take(MAX_RECORDS + 1)
        .map(|record| Counted {
            at: record.at.clone(),
            session: record.session.clone(),
            invocation: record.invocation.clone(),
            model: record.model.clone(),
            input: record.prompt_tokens.unwrap_or(0),
            cached: cached_of(&record),
            cache_write: record.cache_write_tokens.unwrap_or(0),
            output: record.completion_tokens.unwrap_or(0),
            estimated: record.source == tauri_plugin_agent_tools::usage::UsageSource::Estimated,
        })
        .collect();
    if let (Some(key), Ok(mut cache)) = (key, CACHE.lock()) {
        *cache = Some((key, fresh.clone()));
    }
    fresh
}

fn counted_rest(
    data_folder: &Path,
    out: &mut Vec<Counted>,
    known: &std::collections::BTreeSet<String>,
) {
    // The event log, for the runs that only recorded there.
    let events_dir = data_folder.join("events");
    let Ok(entries) = std::fs::read_dir(&events_dir) else { return };
    for entry in entries.flatten().take(10_000) {
        for record in events_file_counted(&entry.path()) {
            if !known.contains(&record.invocation) {
                out.push(record);
            }
        }
    }
}

/// Parsed `usage.reported` dispatches of one session event log, by the file's
/// size and mtime: the quota check runs every turn over up to 10k logs, and
/// re-parsing the unchanged ones each time is most of its cost (report-09
/// MED-3).
fn events_file_counted(path: &Path) -> Vec<Counted> {
    type Key = (std::time::SystemTime, u64);
    type Cache = std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (Key, Vec<Counted>)>>;
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    let key: Option<Key> = std::fs::metadata(path)
        .ok()
        .and_then(|m| Some((m.modified().ok()?, m.len())));
    let cache = CACHE.get_or_init(Default::default);
    if let Some(key) = key {
        if let Some((cached, records)) = cache.lock().ok().and_then(|c| c.get(path).cloned()) {
            if cached == key {
                return records;
            }
        }
    }
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let mut out = Vec::new();
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
            cache_write: payload
                .get("cacheWriteTokens")
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
    if let (Some(key), Ok(mut c)) = (key, cache.lock()) {
        c.insert(path.to_path_buf(), (key, out.clone()));
    }
    out
}

/// What was spent, per model, over a window.
pub fn report(
    data_folder: &Path,
    period: Option<&str>,
    session: Option<&str>,
) -> Result<Report, SpendError> {
    let mut reports = reports(data_folder, &[period], session)?;
    Ok(reports.remove(0))
}

/// One report per period, from a single read of the ledger: the quota check
/// asks for four windows every turn, and each read parses the whole log.
pub(crate) fn reports(
    data_folder: &Path,
    periods: &[Option<&str>],
    session: Option<&str>,
) -> Result<Vec<Report>, SpendError> {
    let prices = prices(data_folder)?;
    let all = counted(data_folder);
    periods
        .iter()
        .map(|period| report_of(&all, &prices, since(*period)?, session))
        .collect()
}

fn report_of(
    all: &[Counted],
    prices: &BTreeMap<String, Price>,
    cutoff: Option<String>,
    session: Option<&str>,
) -> Result<Report, SpendError> {
    let truncated = all.len() > MAX_RECORDS;

    let mut by_model: BTreeMap<String, ModelSpend> = BTreeMap::new();
    let mut dispatches = 0usize;
    let mut earliest: Option<u64> = None;
    for record in all.iter().take(MAX_RECORDS) {
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
            cache_write_tokens: 0,
            output_tokens: 0,
            cost: None,
            estimated_dispatches: 0,
        });
        entry.dispatches += 1;
        dispatches += 1;
        if let Some(at) = epoch_of(&record.at) {
            earliest = Some(earliest.map_or(at, |e| e.min(at)));
        }
        entry.input_tokens += record.input;
        entry.output_tokens += record.output;
        entry.cached_input_tokens += record.cached;
        entry.cache_write_tokens += record.cache_write;
        if record.estimated {
            entry.estimated_dispatches += 1;
        }
    }

    let mut priced_cost = 0.0;
    let mut unpriced = Vec::new();
    for entry in by_model.values_mut() {
        match price_for(prices, &entry.model) {
            Some(price) => {
                let cost = cost_usd(
                    &price,
                    &entry.model,
                    entry.input_tokens,
                    entry.cached_input_tokens,
                    entry.cache_write_tokens,
                    entry.output_tokens,
                );
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
        earliest,
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
pub(crate) fn price_for(prices: &BTreeMap<String, Price>, model: &str) -> Option<Price> {
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
        if model.cached_input_tokens > 0 || model.cache_write_tokens > 0 {
            out.push_str(&format!(
                "      cache: {} read, {} written, {:.0}% of input served from cache\n",
                model.cached_input_tokens,
                model.cache_write_tokens,
                model.cached_input_tokens as f64 * 100.0 / model.input_tokens.max(1) as f64
            ));
        }
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

    #[test]
    fn cache_rates_default_by_family_and_explicit_wins() {
        let plain = Price { input: 10.0, output: 20.0, cached_input: None, cache_write: None };
        // Not Claude: no discount invented.
        assert_eq!(plain.cache_rates("openai/gpt-x"), (10.0, 10.0));
        // Claude: Anthropic's ratios.
        assert_eq!(plain.cache_rates("anthropic/claude-sonnet-5"), (1.0, 12.5));
        let set = Price { cached_input: Some(0.5), cache_write: Some(4.0), ..plain };
        assert_eq!(set.cache_rates("claude-x"), (0.5, 4.0));
    }

    #[test]
    fn cost_treats_cache_as_a_share_of_the_prompt_total() {
        let p = Price { input: 3.0, output: 15.0, cached_input: Some(0.3), cache_write: Some(3.75) };
        // Prompt total 1M of which 600k read and 100k written, 100k out.
        let c = cost_usd(&p, "m", 1_000_000, 600_000, 100_000, 100_000);
        let want = 0.3 * 3.0 + 0.6 * 0.3 + 0.1 * 3.75 + 0.1 * 15.0;
        assert!((c - want).abs() < 1e-9, "{c} vs {want}");
        // Cache counts larger than the total cannot underflow.
        let c = cost_usd(&p, "m", 100, 500, 500, 0);
        assert!((c - 100.0 * 0.3 / 1e6).abs() < 1e-12);
    }

    #[test]
    fn prices_toml_cache_fields_are_optional_and_cache_read_is_an_alias() {
        let old = Workspace::new("spend-cache-old")
            .file("prices.toml", "[models.\"a\"]\ninput = 1.0\noutput = 2.0\n");
        let m = prices(old.path()).unwrap();
        assert_eq!((m["a"].cached_input, m["a"].cache_write), (None, None));
        let new = Workspace::new("spend-cache-new").file(
            "prices.toml",
            "[models.\"a\"]\ninput = 1.0\noutput = 2.0\ncache_read = 0.1\ncache_write = 1.25\n",
        );
        let m = prices(new.path()).unwrap();
        assert_eq!((m["a"].cached_input, m["a"].cache_write), (Some(0.1), Some(1.25)));
    }

    #[test]
    fn a_report_prices_cache_reads_and_writes_separately() {
        let data = Workspace::new("spend-cache-report").file(
            "prices.toml",
            "[models.\"claude-x\"]\ninput = 3.0\noutput = 15.0\n",
        );
        let mut r = usage::record("inv-c", UsageSource::Provider);
        r.model = "claude-x".into();
        r.prompt_tokens = Some(1_000_000);
        r.completion_tokens = Some(0);
        r.cached_prompt_tokens = Some(500_000);
        r.cache_write_tokens = Some(100_000);
        usage::append(data.path(), &r);
        let report = report(data.path(), None, None).unwrap();
        let m = &report.by_model[0];
        assert_eq!((m.cached_input_tokens, m.cache_write_tokens), (500_000, 100_000));
        // 400k plain at 3, 500k read at 0.3, 100k write at 3.75.
        let want = 0.4 * 3.0 + 0.5 * 0.3 + 0.1 * 3.75;
        assert!((m.cost.unwrap() - want).abs() < 1e-9, "{:?}", m.cost);
        assert!(render(&report).contains("cache: 500000 read, 100000 written, 50%"));
    }
}
