//! Values that are secret because the user said so, not because of their
//! shape. janhq/jan#8208.
//!
//! A custom provider header can carry a credential under any name and in any
//! format -- `Ocp-Apim-Subscription-Key: 3f9a…`, `X-Portkey-Config: pc-…` --
//! which no pattern-based redaction recognises. A value the user marked secret
//! is registered here when the provider is, and every log sink replaces it:
//! the desktop log (see `lib.rs`), and the CLI's file log and diagnostic
//! bundle (`cli::secrets`).
//!
//! Both builds, unlike `cli::secrets`: the desktop is where custom headers are
//! configured.

use std::borrow::Cow;
use std::sync::{LazyLock, RwLock};

static VALUES: LazyLock<RwLock<Vec<String>>> = LazyLock::new(|| RwLock::new(Vec::new()));

/// Shorter than this and a value would redact ordinary words.
const MIN_LEN: usize = 4;

/// Redact `value` wherever it appears in anything logged from now on. Kept for
/// the life of the process: a value that stopped being configured is no less
/// a secret in the log lines written about it.
pub fn register(value: &str) {
    let value = value.trim();
    if value.chars().count() < MIN_LEN {
        return;
    }
    let Ok(mut values) = VALUES.write() else { return };
    if !values.iter().any(|v| v == value) {
        values.push(value.to_string());
        // Longest first, so a value containing another is replaced whole.
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
    }
}

/// `text` with every registered value replaced by `<redacted>`; borrowed when
/// it holds none, which is the case on almost every log line.
pub fn scrub(text: &str) -> Cow<'_, str> {
    let Ok(values) = VALUES.read() else {
        return Cow::Borrowed(text);
    };
    if !values.iter().any(|v| text.contains(v.as_str())) {
        return Cow::Borrowed(text);
    }
    let mut out = text.to_string();
    for v in values.iter() {
        out = out.replace(v.as_str(), "<redacted>");
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registered_value_is_replaced_and_a_clean_line_is_borrowed() {
        let value = "sv-8208-registered-value";
        let line = format!("upstream 401 for Ocp-Apim-Subscription-Key {value}");
        assert!(scrub(&line).contains(value), "precondition");
        register(value);
        let out = scrub(&line);
        assert!(!out.contains(value), "{out}");
        assert!(out.ends_with("Ocp-Apim-Subscription-Key <redacted>"), "{out}");
        assert!(matches!(scrub("nothing secret here"), Cow::Borrowed(_)));
    }

    #[test]
    fn a_value_too_short_to_redact_safely_is_left_alone() {
        register("ab");
        assert_eq!(scrub("ab cab"), "ab cab");
    }

    #[test]
    fn a_longer_value_containing_a_shorter_one_is_replaced_whole() {
        register("sv-short");
        register("sv-short-and-longer");
        assert_eq!(scrub("x sv-short-and-longer y"), "x <redacted> y");
    }
}
