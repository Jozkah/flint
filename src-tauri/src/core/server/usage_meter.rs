//! Rolling token ceilings for traffic through the local API server.
//!
//! The server's answers are metered into the same ledger `flint cli agent spend`
//! reads, and judged against the same `quotas.toml` ceilings (`per_5h`,
//! `per_week`, ...), so what a client of the server is refused for and what a
//! person sees in the spend report are one set of numbers.
//!
//! Two limits are stated plainly rather than hidden:
//!
//! * Only answers that carry a provider `usage` object are counted. A server
//!   that streams without reporting usage is not estimated here, because an
//!   estimate presented as a count is how a ceiling stops meaning anything.
//! * A ceiling is judged before a request, so one long answer can overshoot it.
//!   The next request is refused.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::core::agent::quota;

/// How much of the end of a response is kept to look for `usage` in. A stream
/// reports its usage in its last events.
const TAIL: usize = 48 * 1024;

/// How long a judgement is reused. Reading the ledger is a directory walk; a
/// burst of requests should not each pay it.
const JUDGEMENT_TTL: Duration = Duration::from_secs(3);

/// Collects the end of a response body, to read its token counts once it is
/// over.
#[derive(Default)]
pub(crate) struct UsageTap {
    tail: Vec<u8>,
}

impl UsageTap {
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > TAIL * 2 {
            let cut = self.tail.len() - TAIL;
            self.tail.drain(..cut);
        }
    }

    /// `(input, output)` tokens, when the response said.
    pub(crate) fn counts(&self) -> Option<(u64, u64)> {
        extract_usage(&String::from_utf8_lossy(&self.tail))
    }
}

/// The largest input and output counts any `"usage"` object in `text` states.
///
/// Largest, because a stream may split them: Anthropic's `message_start` names
/// the input and its `message_delta` the output, each in its own `usage`.
pub(crate) fn extract_usage(text: &str) -> Option<(u64, u64)> {
    let mut input: Option<u64> = None;
    let mut output: Option<u64> = None;
    let mut at = text.len();
    while let Some(i) = text[..at].rfind("\"usage\"") {
        at = i;
        let Some(rest) = text[i + 7..].trim_start().strip_prefix(':') else { continue };
        let Some(Ok(value)) = serde_json::Deserializer::from_str(rest.trim_start())
            .into_iter::<serde_json::Value>()
            .next()
        else {
            continue;
        };
        let read = |keys: [&str; 2]| {
            keys.iter()
                .find_map(|k| value.get(*k).and_then(serde_json::Value::as_u64))
        };
        if let Some(n) = read(["prompt_tokens", "input_tokens"]) {
            input = Some(input.map_or(n, |m| m.max(n)));
        }
        if let Some(n) = read(["completion_tokens", "output_tokens"]) {
            output = Some(output.map_or(n, |m| m.max(n)));
        }
    }
    if input.is_none() && output.is_none() {
        return None;
    }
    Some((input.unwrap_or(0), output.unwrap_or(0)))
}

/// Write one answer into the ledger.
pub(crate) fn record(data_folder: &Path, model: &str, input: u64, output: u64) {
    use tauri_plugin_agent_tools::usage::{self, UsageSource};
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let stamp = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut row = usage::record(format!("api-server-{stamp}-{n}"), UsageSource::Provider);
    row.session = "api-server".to_string();
    row.model = model.to_string();
    row.prompt_tokens = Some(input);
    row.completion_tokens = Some(output);
    row.total_tokens = Some(input + output);
    usage::append(data_folder, &row);
}

/// Why a request is refused: the message, and how many seconds until capacity
/// starts coming back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub message: String,
    pub retry_after_secs: u64,
}

/// The tightest token ceiling, as the rate-limit headers state it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Headroom {
    pub limit: u64,
    pub remaining: u64,
    pub reset_secs: u64,
}

impl Headroom {
    /// OpenAI-style and Anthropic-style headers, which the SDKs read to pace
    /// themselves. The reset is when the oldest use ages out, so remaining
    /// capacity starts growing then.
    pub(crate) fn headers(&self) -> Vec<(&'static str, String)> {
        let at = std::time::SystemTime::now() + Duration::from_secs(self.reset_secs);
        let rfc = crate::core::agent::spend::rfc3339_of(at);
        vec![
            ("x-ratelimit-limit-tokens", self.limit.to_string()),
            ("x-ratelimit-remaining-tokens", self.remaining.to_string()),
            ("x-ratelimit-reset-tokens", format!("{}s", self.reset_secs)),
            ("anthropic-ratelimit-tokens-limit", self.limit.to_string()),
            ("anthropic-ratelimit-tokens-remaining", self.remaining.to_string()),
            ("anthropic-ratelimit-tokens-reset", rfc),
        ]
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Judgement {
    refusal: Option<Refusal>,
    headroom: Option<Headroom>,
}

static JUDGED: Mutex<Option<(PathBuf, Instant, Judgement)>> = Mutex::new(None);

fn judgement(data_folder: &Path) -> Judgement {
    if let Ok(guard) = JUDGED.lock() {
        if let Some((folder, at, judged)) = guard.as_ref() {
            if folder == data_folder && at.elapsed() < JUDGEMENT_TTL {
                return judged.clone();
            }
        }
    }
    let judged = judge(data_folder);
    if let Ok(mut guard) = JUDGED.lock() {
        *guard = Some((data_folder.to_path_buf(), Instant::now(), judged.clone()));
    }
    judged
}

/// The ceiling that has been reached, if any. A `quotas.toml` that will not
/// parse refuses nothing here and logs it: the agent refuses a run on it, but a
/// server that goes dark over a typo is worse than one that is unmetered until
/// it is fixed.
pub(crate) fn refusal(data_folder: &Path) -> Option<Refusal> {
    judgement(data_folder).refusal
}

/// How much token capacity is left under the tightest token ceiling.
pub(crate) fn headroom(data_folder: &Path) -> Option<Headroom> {
    judgement(data_folder).headroom
}

/// Forget the last judgement, so the next request reads the ledger again.
pub(crate) fn forget() {
    if let Ok(mut guard) = JUDGED.lock() {
        *guard = None;
    }
}

fn judge(data_folder: &Path) -> Judgement {
    let declared = match quota::quotas(data_folder) {
        Ok(declared) => declared,
        Err(e) => {
            log::warn!("api server: quotas.toml not applied: {e}");
            return Judgement::default();
        }
    };
    if !declared.any() {
        return Judgement::default();
    }
    let standings = match quota::standing(data_folder, &declared) {
        Ok(standings) => standings,
        Err(e) => {
            log::warn!("api server: ceilings not judged: {e}");
            return Judgement::default();
        }
    };
    let refusal = standings.iter().find(|s| s.exceeded()).map(|reached| Refusal {
        message: format!(
            "usage ceiling reached -- {}. Raise it in quotas.toml, or wait for the window to roll.",
            reached.describe()
        ),
        retry_after_secs: reached.frees_in_secs.unwrap_or(60).max(1),
    });
    // Standings come tightest first; the first token ceiling is the one a
    // client should pace itself against.
    let headroom = standings
        .iter()
        .find(|s| s.ceiling.starts_with("tokens"))
        .map(|s| Headroom {
            limit: s.limit as u64,
            remaining: (s.limit - s.used).max(0.0) as u64,
            reset_secs: s.frees_in_secs.unwrap_or(0),
        });
    Judgement { refusal, headroom }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_openai_usage_object() {
        let body = r#"{"id":"x","usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}"#;
        assert_eq!(extract_usage(body), Some((12, 34)));
    }

    #[test]
    fn reads_the_last_events_of_a_stream_and_ignores_null_usage() {
        let stream = "data: {\"choices\":[{}],\"usage\":null}\n\n\
                      data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":9}}\n\n\
                      data: [DONE]\n\n";
        assert_eq!(extract_usage(stream), Some((7, 9)));
    }

    #[test]
    fn joins_an_anthropic_stream_that_splits_input_and_output() {
        let stream = "event: message_start\ndata: {\"message\":{\"usage\":{\"input_tokens\":25,\"output_tokens\":1}}}\n\n\
                      event: message_delta\ndata: {\"usage\":{\"output_tokens\":80}}\n\n";
        assert_eq!(extract_usage(stream), Some((25, 80)));
    }

    #[test]
    fn a_body_without_usage_is_not_counted() {
        assert_eq!(extract_usage(r#"{"choices":[{"message":{"content":"hi"}}]}"#), None);
        assert_eq!(extract_usage(r#"{"usage":null}"#), None);
    }

    #[test]
    fn the_tap_keeps_only_the_end_of_a_long_body() {
        let mut tap = UsageTap::default();
        for _ in 0..200 {
            tap.push(&[b'x'; 4096]);
        }
        tap.push(br#"{"usage":{"prompt_tokens":1,"completion_tokens":2}}"#);
        assert!(tap.tail.len() <= TAIL * 2 + 128);
        assert_eq!(tap.counts(), Some((1, 2)));
    }

    #[test]
    fn a_five_hour_ceiling_refuses_and_says_when_capacity_returns() {
        let dir = std::env::temp_dir().join(format!("jan_meter_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(quota::quotas_path(&dir), "[tokens]\nper_5h = 1000\n").unwrap();

        assert_eq!(judge(&dir).refusal, None);
        record(&dir, "local/m", 600, 500);
        let judged = judge(&dir);
        assert_eq!(judged.headroom.as_ref().map(|h| h.remaining), Some(0));
        let refused = judged.refusal.expect("1100 of 1000 is over");
        assert!(refused.message.contains("tokens per 5 hours"), "{}", refused.message);
        // The record is seconds old, so nearly the whole window remains.
        assert!(
            refused.retry_after_secs > 5 * 3600 - 120 && refused.retry_after_secs <= 5 * 3600,
            "{}",
            refused.retry_after_secs
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
