//! Context limits learned from the provider's own overflow errors.
//!
//! A remote model's window is not reported anywhere Flint can read, so proactive
//! compaction assumed the documented 128K default for it. When a provider rejects
//! a request for length it usually says what the limit is ("maximum context
//! length is 8192 tokens", "prompt is too long: 210000 tokens > 200000
//! maximum"). This module reads that number and remembers it per model for the
//! life of the process, so the next run compacts before the limit instead of
//! learning it from another failure.
//!
//! A configured `context_window` always wins; this only fills the gap when there
//! is none. A number outside a sane range is ignored: a provider error that
//! mentions some other count must not shrink the window to nothing.

use std::collections::HashMap;
use std::sync::Mutex;

use regex::Regex;

/// Smallest window worth learning. Below this the number is something else.
const MIN_WINDOW: u64 = 1_024;
/// Largest window worth learning.
const MAX_WINDOW: u64 = 10_000_000;

static LEARNED: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// The context limit a provider overflow message states, if it states one.
pub(crate) fn parse_context_limit(message: &str) -> Option<u64> {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            // OpenAI, vLLM, Azure: "maximum context length is 8192 tokens".
            r"(?i)maximum context length (?:is|of) (\d[\d,_]*)",
            // llama-server: "...n_ctx=4096", "n_ctx = 4096".
            r"(?i)\bn_ctx\s*[=:]\s*(\d[\d,_]*)",
            // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum".
            r"(?i)prompt is too long: *\d[\d,_]* tokens? *> *(\d[\d,_]*)",
            // Gemini: "exceeds the maximum number of tokens allowed (1048576)".
            r"(?i)maximum number of tokens allowed *\((\d[\d,_]*)\)",
            // "context window of 32768 tokens", "context size is 32768".
            r"(?i)context (?:window|size|length) (?:is|of) (\d[\d,_]*)",
        ]
        .iter()
        .filter_map(|p| Regex::new(p).ok())
        .collect()
    });
    patterns.iter().find_map(|re| {
        let digits: String = re
            .captures(message)?
            .get(1)?
            .as_str()
            .chars()
            .filter(char::is_ascii_digit)
            .collect();
        let n: u64 = digits.parse().ok()?;
        (MIN_WINDOW..=MAX_WINDOW).contains(&n).then_some(n)
    })
}

/// Remember `tokens` as the window of `model`. A smaller number replaces a
/// larger one (a limit only ever turns out lower than assumed); a larger one
/// never replaces a smaller one the provider has already confirmed.
pub(crate) fn record(model: &str, tokens: u64) {
    if model.is_empty() || !(MIN_WINDOW..=MAX_WINDOW).contains(&tokens) {
        return;
    }
    let mut table = LEARNED.lock().unwrap();
    let table = table.get_or_insert_with(HashMap::new);
    let entry = table.entry(model.to_string()).or_insert(tokens);
    *entry = (*entry).min(tokens);
}

/// The window learned for `model`, if any.
pub(crate) fn lookup(model: &str) -> Option<u64> {
    LEARNED.lock().unwrap().as_ref()?.get(model).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_limit_from_each_provider_wording() {
        let cases = [
            (
                "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens",
                8_192,
            ),
            ("maximum context length is 262,144 tokens", 262_144),
            (
                "the request exceeds the available context size, try increasing it: n_prompt_tokens=9000, n_ctx=4096",
                4_096,
            ),
            ("prompt is too long: 210000 tokens > 200000 maximum", 200_000),
            (
                "input token count (1200000) exceeds the maximum number of tokens allowed (1048576)",
                1_048_576,
            ),
        ];
        for (message, expected) in cases {
            assert_eq!(parse_context_limit(message), Some(expected), "{message}");
        }
    }

    #[test]
    fn ignores_messages_with_no_limit_or_an_absurd_one() {
        assert_eq!(parse_context_limit("invalid api key"), None);
        assert_eq!(parse_context_limit("context length exceeded"), None);
        assert_eq!(parse_context_limit("maximum context length is 12 tokens"), None);
        assert_eq!(parse_context_limit("maximum context length is 99999999999 tokens"), None);
    }

    #[test]
    fn a_small_learned_window_still_gives_a_compaction_threshold() {
        use crate::core::agent::compaction_policy as cpol;
        // The default reserve is larger than any small window: the run clamps
        // it to a quarter of the learned window, so it still starts.
        for window in [1_024u64, 4_096, 8_192, 16_384] {
            let reserve = 16_384u64.min(window / 4);
            let cfg = cpol::WindowConfig::from_config(Some(window), Some(reserve));
            assert!(cpol::thresholds(&cfg).is_ok() || window <= 2_048, "window {window}");
        }
    }

    #[test]
    fn remembers_the_lowest_limit_a_model_has_shown() {
        record("learned-test/model-a", 32_768);
        assert_eq!(lookup("learned-test/model-a"), Some(32_768));
        record("learned-test/model-a", 16_384);
        assert_eq!(lookup("learned-test/model-a"), Some(16_384));
        record("learned-test/model-a", 65_536);
        assert_eq!(lookup("learned-test/model-a"), Some(16_384));
        assert_eq!(lookup("learned-test/never-seen"), None);
        record("", 8_192);
        record("learned-test/model-b", 10);
        assert_eq!(lookup("learned-test/model-b"), None);
    }
}
