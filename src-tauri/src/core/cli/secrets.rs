//! Secret scrubbing shared by the persistent log sink and the diagnostic
//! bundle.
//!
//! Adapted from janhq/jan#8713 (thinhlpg). Two sinks write user text to disk:
//! `file_log` (every record, as it happens) and `doctor` (the bundle a user
//! may choose to attach to an issue). Both need the same answer to "is this a
//! credential?", so the rules live here once.
//!
//! The rules are deliberately broad and matched on text: an upstream error can
//! echo the request's `Authorization` header back, a user can paste a key into
//! a prompt, and a provider can name a token in a message. Over-matching costs
//! a `<redacted>` in a log line; under-matching leaks a credential into a file
//! that may end up attached to a public issue.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;

/// One redaction rule: a labelled regex. When the regex has a first capture
/// group, that part (the label -- `Authorization: Bearer `, `"api_key":"`) is
/// kept and only the rest replaced, so a redacted JSON record still parses and
/// still says which field was removed.
pub(crate) struct Rule {
    pub(crate) label: &'static str,
    pub(crate) re: Regex,
}

/// Strips secrets from free text and tallies how many of each kind it hit.
pub(crate) struct Redactor {
    pub(crate) rules: Vec<Rule>,
}

/// The process-wide redactor. The regexes are compiled once: the log sink runs
/// them on every record.
pub(crate) static SHARED: LazyLock<Redactor> = LazyLock::new(Redactor::new);

impl Redactor {
    pub(crate) fn new() -> Self {
        // Authorization headers first (they contain a bearer whose value other
        // rules would also match), then explicit key-like config values, then
        // well-known provider token prefixes, then long opaque tokens.
        let rules = vec![
            Rule {
                label: "authorization header",
                re: Regex::new(
                    r#"(?i)(["']?authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[A-Za-z0-9._~+/\-=]+"#,
                )
                .expect("auth header regex"),
            },
            Rule {
                label: "api key / token value",
                // Both `api_key="..."` and JSON `"api_key":"..."`.
                re: Regex::new(
                    r#"(?i)(["']?(?:api[_-]?key|apikey|secret|token|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/\-=]{12,}"#,
                )
                .expect("key regex"),
            },
            Rule {
                label: "password value",
                // `DB_PASSWORD = hunter2`, `"password":"..."`: a password has no
                // recognisable shape, so the name is what identifies it. Also
                // catches one quoted inside a JSON string, which a line-shape
                // scanner reading the whole record does not.
                re: Regex::new(
                    r#"(?i)(["']?[A-Za-z0-9_]*(?:password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}"#,
                )
                .expect("password regex"),
            },
            Rule {
                label: "jwt",
                re: Regex::new(
                    r"(?i)eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
                )
                .expect("jwt regex"),
            },
            Rule {
                label: "sk/pk provider key",
                re: Regex::new(r"(?i)\b(?:sk|pk)-[A-Za-z0-9_\-]{16,}").expect("sk key regex"),
            },
            Rule {
                label: "google api key",
                re: Regex::new(r"\bAIza[A-Za-z0-9_\-]{20,}").expect("google key regex"),
            },
            Rule {
                label: "github token",
                re: Regex::new(r"\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})")
                    .expect("github token regex"),
            },
            Rule {
                label: "slack token",
                re: Regex::new(r"\bxox[baprs]-[A-Za-z0-9-]{16,}").expect("slack token regex"),
            },
            Rule {
                label: "aws access key",
                re: Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").expect("aws key regex"),
            },
            Rule {
                label: "nvidia api key",
                re: Regex::new(r"\bnvapi-[A-Za-z0-9_-]{16,}").expect("nvidia key regex"),
            },
            Rule {
                label: "opaque oauth token",
                re: Regex::new(
                    r"\b(?:ya29\.[A-Za-z0-9_\-]{30,}|sq0atp-[A-Za-z0-9_\-]{20,}|sk_live_[A-Za-z0-9]{16,})",
                )
                .expect("opaque token regex"),
            },
        ];
        Redactor { rules }
    }

    /// Replace every match with `<redacted>`; `hits` records per-rule counts.
    pub(crate) fn redact(&self, input: &str, hits: &mut [usize]) -> String {
        let mut out = Cow::Borrowed(input);
        if let Some(replaced) = apply_exact(&out) {
            out = Cow::Owned(replaced);
        }
        for (i, rule) in self.rules.iter().enumerate() {
            if let Some(replaced) = apply(&rule.re, &out, Some(&mut hits[i])) {
                out = Cow::Owned(replaced);
            }
        }
        out.into_owned()
    }

    /// Redact without tallying, borrowing the input when it holds no secret.
    ///
    /// The log sink's path: it runs on every record, and the overwhelmingly
    /// common case is a clean line, which must not allocate.
    pub(crate) fn scrub<'a>(&self, input: &'a str) -> Cow<'a, str> {
        let mut out = Cow::Borrowed(input);
        if let Some(replaced) = apply_exact(&out) {
            out = Cow::Owned(replaced);
        }
        for rule in &self.rules {
            if let Some(replaced) = apply(&rule.re, &out, None) {
                out = Cow::Owned(replaced);
            }
        }
        out
    }
}

/// Values the user marked secret, whatever their shape, which no rule above
/// recognises. janhq/jan#8208; see `core::secret_values`.
fn apply_exact(text: &str) -> Option<String> {
    match crate::core::secret_values::scrub(text) {
        Cow::Owned(out) => Some(out),
        Cow::Borrowed(_) => None,
    }
}

/// Replace every match of `re` in `text`, returning `None` when it does not
/// match at all so the caller can keep borrowing the original.
///
/// Spans are collected before any replacement so a `<redacted>` inserted by
/// this rule is never re-scanned by it.
fn apply(re: &Regex, text: &str, hits: Option<&mut usize>) -> Option<String> {
    // (start of the replaced part, end of the match); a kept label is copied.
    let spans: Vec<(usize, usize)> = re
        .captures_iter(text)
        .filter_map(|c| {
            let whole = c.get(0)?;
            let from = c.get(1).map_or(whole.start(), |label| label.end());
            Some((from, whole.end()))
        })
        .collect();
    if spans.is_empty() {
        return None;
    }
    if let Some(n) = hits {
        *n += spans.len();
    }
    let mut result = String::with_capacity(text.len());
    let mut last = 0;
    for (s, e) in spans {
        result.push_str(&text[last..s]);
        result.push_str("<redacted>");
        last = e;
    }
    result.push_str(&text[last..]);
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// janhq/jan#8208. A secret custom header's value has no shape any rule
    /// knows, under a name no rule knows; once registered it is redacted
    /// wherever it turns up, by both sinks.
    #[test]
    fn a_registered_value_is_redacted_whatever_its_shape() {
        let value = "q7Zr-exact-8208-value";
        let line = format!("upstream 401: Ocp-Apim-Subscription-Key {value} rejected");
        assert!(SHARED.scrub(&line).contains(value), "precondition: no rule knows it");
        crate::core::secret_values::register(value);
        let scrubbed = SHARED.scrub(&line);
        assert!(!scrubbed.contains(value), "{scrubbed}");
        assert!(scrubbed.contains("Ocp-Apim-Subscription-Key <redacted> rejected"));
        let mut hits = vec![0; SHARED.rules.len()];
        assert!(!SHARED.redact(&line, &mut hits).contains(value));
    }

    /// A clean line is the common case on the log path: it comes back
    /// borrowed, with no allocation.
    /// Jozkah/jan#276: `messages.jsonl` stores message text and tool
    /// arguments as JSON strings, so a pasted config's credential arrives
    /// escaped (`\"api_key\": \"...\"`). The rules must catch that form, and the
    /// record must still parse afterwards.
    #[test]
    fn a_credential_inside_an_escaped_json_string_is_redacted() {
        let record = serde_json::json!({
            "role": "user",
            "content": r#"my config is {"api_key": "abcdefghijklmnop1234", "token":"qrstuvwxyz567890abcd", "db_password":"hunter2seventeen", "Authorization": "Bearer zzzzzzzzzzzzzzzzzzzz"}"#,
        })
        .to_string();
        let scrubbed = SHARED.scrub(&record);
        for secret in ["abcdefghijklmnop1234", "qrstuvwxyz567890abcd", "hunter2seventeen", "zzzzzzzzzzzzzzzzzzzz"] {
            assert!(!scrubbed.contains(secret), "{secret} survived: {scrubbed}");
        }
        serde_json::from_str::<serde_json::Value>(&scrubbed).expect("still valid JSON");
    }

    #[test]
    fn scrub_borrows_a_clean_line() {
        let line = "agent: run finished outcome=ok elapsed=6022ms";
        assert!(matches!(SHARED.scrub(line), Cow::Borrowed(_)));
    }

    /// A provider echoed the request's `Authorization` header inside its error
    /// body, and that error is written to the log as a breadcrumb.
    #[test]
    fn scrub_strips_an_echoed_authorization_header() {
        let line = "agent: run finished outcome=error -- Body: \
                    {\"error\":{\"message\":\"bad request; authorization: Bearer \
                    sk-live-11112222333344445555\"}}";
        let out = SHARED.scrub(line);
        assert!(!out.contains("sk-live-11112222333344445555"), "leaked: {out}");
        assert!(out.contains("<redacted>"), "replacement is marked: {out}");
        assert!(out.contains("outcome=error"), "the breadcrumb survives: {out}");
    }

    /// A password assignment carries no token shape; its name is the tell,
    /// including inside a JSON-encoded chat message.
    #[test]
    fn scrub_strips_a_password_assignment_even_inside_json() {
        for line in [
            "DB_PASSWORD = hunter2hunter2",
            r#"{"role":"user","content":"DB_PASSWORD = hunter2hunter2"}"#,
            r#"{"password":"hunter2hunter2"}"#,
        ] {
            let out = SHARED.scrub(line);
            assert!(!out.contains("hunter2hunter2"), "leaked: {out}");
            // The label stays, so a redacted record still parses.
            if line.starts_with('{') {
                serde_json::from_str::<serde_json::Value>(&out)
                    .unwrap_or_else(|e| panic!("redaction broke the JSON ({e}): {out}"));
            }
        }
        assert_eq!(
            SHARED.scrub(r#"{"api_key":"abcdefghijklmnopqrstuvwx"}"#),
            r#"{"api_key":"<redacted>"}"#
        );
        assert_eq!(
            SHARED.scrub("Authorization: Bearer abc123def456ghi"),
            "Authorization: Bearer <redacted>"
        );
        // Talking about passwords is not a password.
        let prose = "please reset my password tomorrow";
        assert_eq!(SHARED.scrub(prose), prose);
    }

    /// Scrubbing does not depend on where in the line the secret sits.
    #[test]
    fn scrub_strips_a_key_far_into_a_long_line() {
        let line = format!("prefix {} api_key=sk-live-99998888777766665555", "x".repeat(4000));
        let out = SHARED.scrub(&line);
        assert!(!out.contains("sk-live-99998888777766665555"), "leaked past the budget");
    }
}
