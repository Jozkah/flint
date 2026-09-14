//! Ceilings that hold across runs: tokens (AH-191) and money (AH-192).
//!
//! A session budget stops one run. Neither of these is about one run: they are
//! about what a person or a project may use in a day or a month, which is the
//! number anybody actually cares about when they say "keep it under $20".
//!
//! Two things keep this honest:
//!
//! * **Nobody's ceiling is invented.** No `quotas.toml` means no ceilings, and
//!   a file that will not parse, or carries a negative or non-finite number, is
//!   refused whole. Half a quota file would enforce a ceiling nobody wrote.
//! * **A money ceiling can only judge what has a price.** Prices are declared
//!   by a person (`prices.toml`, AH-175), and usage of a model nobody priced
//!   cannot be turned into dollars. It is counted, named, and reported beside
//!   the answer rather than folded in as zero -- a spend ceiling that silently
//!   treats unpriced use as free is a ceiling that does not hold.
//!
//! The ledger these read is the same one `flint cli agent spend` reports, so what
//! stops a run and what a person sees are the same numbers.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::agent::spend::{self, Report};

/// What went wrong reading or judging a quota.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaErrorKind {
    /// The quota file is there and cannot be understood.
    Malformed,
    /// The ledger could not be read, so nothing can be judged.
    Unreadable,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaError {
    pub kind: QuotaErrorKind,
    pub message: String,
}

impl QuotaError {
    fn new(kind: QuotaErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: tauri_plugin_agent_tools::harness_error::scrub(&message.into()),
        }
    }
}

impl std::fmt::Display for QuotaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// In the harness's own vocabulary (AH-009).
impl From<&QuotaError> for tauri_plugin_agent_tools::harness_error::HarnessError {
    fn from(error: &QuotaError) -> Self {
        use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
        let kind = match error.kind {
            QuotaErrorKind::Malformed => ErrorKind::InvalidInput,
            QuotaErrorKind::Unreadable => ErrorKind::Io,
        };
        HarnessError::new(kind, error.message.clone()).at(Stage::Startup)
    }
}

/// The declared ceilings. Every one is optional; a file that sets none sets
/// none.
#[derive(Deserialize, Serialize, Default, Clone, Debug, PartialEq)]
pub struct Quotas {
    #[serde(default)]
    pub tokens: TokenQuotas,
    #[serde(default)]
    pub spend: SpendQuotas,
}

/// Tokens, counted across runs (AH-191).
#[derive(Deserialize, Serialize, Default, Clone, Debug, PartialEq)]
pub struct TokenQuotas {
    /// Input plus output, over the last 24 hours.
    #[serde(default)]
    pub per_day: Option<u64>,
    /// Over the last 30 days.
    #[serde(default)]
    pub per_month: Option<u64>,
}

/// Money, in dollars, counted across runs (AH-192).
#[derive(Deserialize, Serialize, Default, Clone, Debug, PartialEq)]
pub struct SpendQuotas {
    #[serde(default)]
    pub per_day: Option<f64>,
    #[serde(default)]
    pub per_month: Option<f64>,
}

pub fn quotas_path(data_folder: &Path) -> PathBuf {
    data_folder.join("quotas.toml")
}

/// Read the declared ceilings. No file means none, which is not an error.
pub fn quotas(data_folder: &Path) -> Result<Quotas, QuotaError> {
    let raw = match std::fs::read_to_string(quotas_path(data_folder)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Quotas::default()),
        Err(e) => {
            return Err(QuotaError::new(
                QuotaErrorKind::Unreadable,
                format!("quotas.toml: {e}"),
            ))
        }
    };
    let parsed: Quotas = toml::from_str(&raw).map_err(|e| {
        QuotaError::new(QuotaErrorKind::Malformed, format!("quotas.toml: {e}"))
    })?;
    for (what, value) in [
        ("spend.per_day", parsed.spend.per_day),
        ("spend.per_month", parsed.spend.per_month),
    ] {
        if let Some(value) = value {
            if !value.is_finite() || value < 0.0 {
                return Err(QuotaError::new(
                    QuotaErrorKind::Malformed,
                    format!("quotas.toml: {what} is not an amount of dollars"),
                ));
            }
        }
    }
    Ok(parsed)
}

impl Quotas {
    /// Whether anything is declared at all. Nothing declared means nothing to
    /// read, and nothing to read means no ledger work per turn.
    pub fn any(&self) -> bool {
        self.tokens.per_day.is_some()
            || self.tokens.per_month.is_some()
            || self.spend.per_day.is_some()
            || self.spend.per_month.is_some()
    }
}

/// One ceiling, and where use stands against it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    /// `tokens per day`, `spend per month`, and so on.
    pub ceiling: String,
    /// What has been used in that window, in the ceiling's own unit.
    pub used: f64,
    pub limit: f64,
    /// Models used in the window that nobody has priced, for a spend ceiling:
    /// their use is real and cannot be turned into dollars, so it is named
    /// rather than counted as nothing.
    pub unpriced: Vec<String>,
}

impl Standing {
    pub fn exceeded(&self) -> bool {
        self.used >= self.limit
    }

    /// What to tell a person, in their own units.
    pub fn describe(&self) -> String {
        let money = self.ceiling.starts_with("spend");
        let render = |v: f64| {
            if money {
                format!("${v:.4}")
            } else {
                format!("{} tokens", v as u64)
            }
        };
        let mut text = format!(
            "{}: {} of {}",
            self.ceiling,
            render(self.used),
            render(self.limit)
        );
        if !self.unpriced.is_empty() {
            text.push_str(&format!(
                " (not counted, because nobody has said what they cost: {})",
                self.unpriced.join(", ")
            ));
        }
        text
    }
}

/// Where use stands against every declared ceiling, most pressing first.
///
/// The windows are read from the same ledger `flint cli agent spend` reports, so
/// what stops a run and what a person sees are the same numbers.
pub fn standing(data_folder: &Path, quotas: &Quotas) -> Result<Vec<Standing>, QuotaError> {
    if !quotas.any() {
        return Ok(Vec::new());
    }
    let read = |period: &str| -> Result<Report, QuotaError> {
        spend::report(data_folder, Some(period), None).map_err(|e| {
            QuotaError::new(QuotaErrorKind::Unreadable, format!("the ledger: {}", e.message))
        })
    };
    let day = (quotas.tokens.per_day.is_some() || quotas.spend.per_day.is_some())
        .then(|| read("24h"))
        .transpose()?;
    let month = (quotas.tokens.per_month.is_some() || quotas.spend.per_month.is_some())
        .then(|| read("30d"))
        .transpose()?;

    let mut out = Vec::new();
    let mut push_tokens = |name: &str, limit: Option<u64>, report: Option<&Report>| {
        if let (Some(limit), Some(report)) = (limit, report) {
            out.push(Standing {
                ceiling: name.to_string(),
                used: (report.input_tokens + report.output_tokens) as f64,
                limit: limit as f64,
                // Tokens are tokens whether or not anybody priced them.
                unpriced: Vec::new(),
            });
        }
    };
    push_tokens("tokens per day", quotas.tokens.per_day, day.as_ref());
    push_tokens("tokens per month", quotas.tokens.per_month, month.as_ref());

    let mut push_spend = |name: &str, limit: Option<f64>, report: Option<&Report>| {
        if let (Some(limit), Some(report)) = (limit, report) {
            out.push(Standing {
                ceiling: name.to_string(),
                used: report.priced_cost,
                limit,
                unpriced: report.unpriced_models.clone(),
            });
        }
    };
    push_spend("spend per day", quotas.spend.per_day, day.as_ref());
    push_spend("spend per month", quotas.spend.per_month, month.as_ref());

    // The one closest to its ceiling first: that is the one a person needs to
    // read, and the one a refusal should name.
    out.sort_by(|a, b| {
        let share = |s: &Standing| {
            if s.limit > 0.0 {
                s.used / s.limit
            } else {
                f64::INFINITY
            }
        };
        share(b)
            .partial_cmp(&share(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// The ceiling that has been reached, if any.
///
/// Called before a run starts and again before each turn's request: the ledger
/// grows as the run goes, so a run that crosses its ceiling mid-way stops
/// there rather than at the end.
pub fn exceeded(data_folder: &Path, quotas: &Quotas) -> Result<Option<Standing>, QuotaError> {
    Ok(standing(data_folder, quotas)?
        .into_iter()
        .find(Standing::exceeded))
}

/// What a run is told when a ceiling has been reached.
pub fn refusal(standing: &Standing) -> tauri_plugin_agent_tools::harness_error::HarnessError {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Retry, Stage};
    HarnessError::new(
        ErrorKind::BudgetExhausted,
        format!(
            "this run was stopped by a ceiling in quotas.toml -- {}. Raise it there, or wait for \
             the window to pass.",
            standing.describe()
        ),
    )
    .at(Stage::Startup)
    // Retrying immediately would hit the same ceiling; the window has to pass,
    // and how long that is depends on when the spending happened.
    .with_retry(Retry::Never)
}

/// Every ceiling and where use stands, as a person reads it.
pub fn render(standings: &[Standing]) -> String {
    if standings.is_empty() {
        return "no ceilings are declared in quotas.toml\n".to_string();
    }
    let mut out = String::new();
    for standing in standings {
        out.push_str(&format!(
            "  {}{}\n",
            standing.describe(),
            if standing.exceeded() { "  REACHED" } else { "" }
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_data(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jan_quota_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp data folder");
        dir
    }

    /// Write one dispatch into the same ledger `spend` reads: the events a
    /// headless run writes.
    fn record(data: &Path, model: &str, input: u64, output: u64) {
        use tauri_plugin_agent_tools::event_log::{append, NewEvent};
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // A dispatch's model is what its run said it was answering with, the
        // way a real headless run records it.
        let run = format!("quota-session#run-{n}");
        append(
            data,
            NewEvent {
                id: format!("quota-start-{n}"),
                session: "quota-session".to_string(),
                run: run.clone(),
                invocation: String::new(),
                kind: "run.started".to_string(),
                payload: serde_json::json!({ "model": model }),
            },
        )
        .expect("the ledger takes the run");
        append(
            data,
            NewEvent {
                id: format!("quota-evt-{n}"),
                session: "quota-session".to_string(),
                run: run.clone(),
                invocation: format!("{run}#req-1"),
                kind: "usage.reported".to_string(),
                payload: serde_json::json!({
                    "model": model,
                    "inputTokens": input,
                    "outputTokens": output,
                    "cachedInputTokens": 0,
                    "source": "provider",
                }),
            },
        )
        .expect("the ledger takes a record");
    }

    /// No file is no ceilings, and no ceilings is no work.
    #[test]
    fn no_quota_file_declares_nothing() {
        let data = temp_data("none");
        let quotas = quotas(&data).expect("no file is not an error");
        assert_eq!(quotas, Quotas::default());
        assert!(!quotas.any());
        assert!(standing(&data, &quotas).expect("nothing to read").is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    /// A file that will not parse, or that carries an impossible amount, is
    /// refused whole: half a quota file enforces a ceiling nobody wrote.
    #[test]
    fn a_malformed_or_impossible_quota_file_is_refused_whole() {
        let data = temp_data("bad");
        std::fs::write(quotas_path(&data), "[tokens\nper_day = 1\n").unwrap();
        let err = quotas(&data).unwrap_err();
        assert_eq!(err.kind, QuotaErrorKind::Malformed);

        std::fs::write(quotas_path(&data), "[spend]\nper_day = -5.0\n").unwrap();
        let err = quotas(&data).unwrap_err();
        assert_eq!(err.kind, QuotaErrorKind::Malformed);
        assert!(err.message.contains("spend.per_day"), "{err}");

        std::fs::write(quotas_path(&data), "[spend]\nper_day = nan\n").unwrap();
        assert_eq!(quotas(&data).unwrap_err().kind, QuotaErrorKind::Malformed);
        let _ = std::fs::remove_dir_all(&data);
    }

    /// AH-191: tokens are counted across runs, and the ceiling is reached by
    /// what the ledger holds -- not by anything one run remembers.
    #[test]
    fn a_token_ceiling_is_judged_against_the_ledger() {
        let data = temp_data("tokens");
        std::fs::write(quotas_path(&data), "[tokens]\nper_day = 1000\n").unwrap();
        let quotas = quotas(&data).expect("reads");
        assert!(exceeded(&data, &quotas).expect("judged").is_none());

        record(&data, "mock/m", 400, 100);
        let standing = standing(&data, &quotas).expect("judged");
        assert_eq!(standing.len(), 1);
        assert_eq!(standing[0].used, 500.0);
        assert!(!standing[0].exceeded());
        assert!(exceeded(&data, &quotas).expect("judged").is_none());

        record(&data, "mock/m", 400, 200);
        let reached = exceeded(&data, &quotas).expect("judged").expect("reached");
        assert_eq!(reached.ceiling, "tokens per day");
        assert_eq!(reached.used, 1100.0);
        let refusal = refusal(&reached);
        assert_eq!(
            refusal.kind(),
            tauri_plugin_agent_tools::harness_error::ErrorKind::BudgetExhausted
        );
        assert!(refusal.message().contains("tokens per day"), "{refusal}");
        let _ = std::fs::remove_dir_all(&data);
    }

    /// AH-192: money is judged only where a price was declared, and use of a
    /// model nobody priced is named rather than counted as free.
    #[test]
    fn a_spend_ceiling_counts_what_has_a_price_and_names_what_does_not() {
        let data = temp_data("spend");
        std::fs::write(quotas_path(&data), "[spend]\nper_day = 0.01\n").unwrap();
        let quotas = quotas(&data).expect("reads");

        // A million input tokens of an unpriced model: real use, no dollars.
        record(&data, "mystery/m", 1_000_000, 0);
        let standing = standing(&data, &quotas).expect("judged");
        assert_eq!(standing[0].used, 0.0);
        assert_eq!(standing[0].unpriced, vec!["mystery/m".to_string()]);
        assert!(!standing[0].exceeded(), "nothing priced was spent");
        assert!(standing[0].describe().contains("mystery/m"), "{}", standing[0].describe());

        // Declare a price, and the same kind of use is counted.
        std::fs::write(
            crate::core::agent::spend::prices_path(&data),
            "[models.\"priced\"]\ninput = 10.0\noutput = 10.0\n",
        )
        .unwrap();
        record(&data, "vendor/priced", 2_000, 0);
        let reached = exceeded(&data, &quotas).expect("judged").expect("reached");
        assert_eq!(reached.ceiling, "spend per day");
        assert!((reached.used - 0.02).abs() < 1e-9, "{}", reached.used);
        assert!(reached.exceeded());
        let _ = std::fs::remove_dir_all(&data);
    }

    /// The ceiling closest to being reached is the one a person is shown
    /// first, and the one a refusal names.
    #[test]
    fn the_tightest_ceiling_is_the_one_reported() {
        let data = temp_data("order");
        std::fs::write(
            quotas_path(&data),
            "[tokens]\nper_day = 1000\nper_month = 1000000\n",
        )
        .unwrap();
        let quotas = quotas(&data).expect("reads");
        record(&data, "mock/m", 900, 0);
        let standing = standing(&data, &quotas).expect("judged");
        assert_eq!(standing[0].ceiling, "tokens per day");
        assert_eq!(standing[1].ceiling, "tokens per month");
        assert!(render(&standing).contains("tokens per day"));
        let _ = std::fs::remove_dir_all(&data);
    }
}
