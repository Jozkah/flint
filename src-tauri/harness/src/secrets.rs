//! Credential detection and redaction (AH-045, AH-157).
//!
//! Tool output is the widest uncontrolled channel in the harness: a `bash` call
//! can print an environment, a `read` can return a `.env`, a diff can carry a
//! key that was pasted into a config file. Everything downstream of that output
//! is durable or leaves the machine -- the event log, the run journal, an audit
//! export, the transcript the next turn sends to a model -- so a credential that
//! reaches the output once reaches all of them.
//!
//! This module is the one place that decides what a credential looks like. Two
//! entry points, one detector:
//!
//! - [`redact`] replaces every match with a marker naming the kind, for text
//!   that must still be readable (a command line in an audit event, a log line).
//! - [`scan`] returns the matches with their positions, for callers that must
//!   refuse rather than rewrite -- a diff about to be committed, where silently
//!   editing the content would be worse than declining it.
//!
//! It is deliberately written without a regular-expression engine. This crate is
//! linked by the desktop app, the headless CLI and every test suite, and stays
//! dependency-light on purpose; the patterns here are prefix, shape and
//! assignment rules, all of which a hand-rolled scanner expresses directly and
//! runs in one pass per rule.
//!
//! ## What it deliberately does not claim
//!
//! Detection is a floor, not a proof. A high-entropy string with no recognisable
//! prefix, no secret-ish name and no credential shape is indistinguishable from a
//! hash or an id, and guessing at it would redact commit SHAs and content
//! addresses out of every diff in the app. The rules below are the ones that
//! carry a name or a vendor prefix, plus the assignment form that names itself.
//! Callers that need a hard guarantee (an audit event, for one) must also bound
//! *what fields* they record, which is what `recorder::redacted_resource` does:
//! redaction and field discipline are complementary, not alternatives.

use std::fmt;

/// The kind of credential a match looks like. Named in the redaction marker, so
/// a reader of a redacted log can tell "an AWS key was here" from "a password
/// assignment was here" without the value coming back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SecretKind {
    /// `AKIA…`/`ASIA…` -- an AWS access key id.
    AwsAccessKeyId,
    /// A GitHub personal-access, OAuth, app or refresh token (`ghp_`, `gho_`,
    /// `ghs_`, `ghu_`, `ghr_`, `github_pat_`).
    GitHubToken,
    /// An OpenAI-style key (`sk-`, `sk-proj-`).
    OpenAiKey,
    /// An Anthropic key (`sk-ant-`).
    AnthropicKey,
    /// A Slack token (`xoxb-`, `xoxp-`, `xoxa-`, `xoxs-`, `xapp-`).
    SlackToken,
    /// A Google API key (`AIza…`).
    GoogleApiKey,
    /// A GitLab personal-access token (`glpat-`).
    GitLabToken,
    /// A Hugging Face access token (`hf_`).
    HuggingFaceToken,
    /// An npm access token (`npm_`).
    NpmToken,
    /// A Stripe key (`sk_live_`, `rk_live_`).
    StripeKey,
    /// A SendGrid key (`SG.`).
    SendGridKey,
    /// A PEM-armoured private key block.
    PrivateKey,
    /// A JSON Web Token.
    Jwt,
    /// The credential part of an `Authorization:`/`Bearer` header.
    AuthorizationHeader,
    /// The password in a `scheme://user:password@host` URL.
    UrlPassword,
    /// The value of an assignment whose *name* says it is a secret
    /// (`API_KEY=…`, `"password": "…"`, `--token …`).
    AssignedSecret,
}

impl SecretKind {
    /// The short name used in the redaction marker.
    pub fn label(self) -> &'static str {
        match self {
            SecretKind::AwsAccessKeyId => "aws-access-key-id",
            SecretKind::GitHubToken => "github-token",
            SecretKind::OpenAiKey => "openai-key",
            SecretKind::AnthropicKey => "anthropic-key",
            SecretKind::SlackToken => "slack-token",
            SecretKind::GoogleApiKey => "google-api-key",
            SecretKind::GitLabToken => "gitlab-token",
            SecretKind::HuggingFaceToken => "huggingface-token",
            SecretKind::NpmToken => "npm-token",
            SecretKind::StripeKey => "stripe-key",
            SecretKind::SendGridKey => "sendgrid-key",
            SecretKind::PrivateKey => "private-key",
            SecretKind::Jwt => "jwt",
            SecretKind::AuthorizationHeader => "authorization",
            SecretKind::UrlPassword => "url-password",
            SecretKind::AssignedSecret => "secret",
        }
    }
}

impl fmt::Display for SecretKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// One detected credential, located by byte offset in the scanned text.
///
/// `line` is 1-based, so a finding can be reported the way every other tool
/// reports one. `start`/`end` are byte offsets into the whole text and always
/// fall on character boundaries, which is what lets [`redact`] slice safely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub kind: SecretKind,
    pub line: usize,
    pub start: usize,
    pub end: usize,
}

impl Finding {
    /// A one-line description with no part of the value in it.
    pub fn describe(&self) -> String {
        format!("{} at line {}", self.kind.label(), self.line)
    }
}

/// Vendor prefixes whose mere presence, followed by enough token characters, is
/// a credential. Each entry is (prefix, minimum characters *after* the prefix).
///
/// The minimums are what stop a prose mention (`ghp_` in a sentence, `sk-` in a
/// hyphenated word) from being reported. They are deliberately below the real
/// lengths: a vendor lengthening a token must not silently stop detection.
const PREFIXES: &[(&str, usize, SecretKind)] = &[
    ("AKIA", 12, SecretKind::AwsAccessKeyId),
    ("ASIA", 12, SecretKind::AwsAccessKeyId),
    ("github_pat_", 20, SecretKind::GitHubToken),
    ("ghp_", 20, SecretKind::GitHubToken),
    ("gho_", 20, SecretKind::GitHubToken),
    ("ghs_", 20, SecretKind::GitHubToken),
    ("ghu_", 20, SecretKind::GitHubToken),
    ("ghr_", 20, SecretKind::GitHubToken),
    // Anthropic before OpenAI: `sk-ant-` also starts with `sk-`, and the first
    // matching prefix wins, so the more specific one has to be tried first.
    ("sk-ant-", 16, SecretKind::AnthropicKey),
    ("sk-proj-", 16, SecretKind::OpenAiKey),
    ("sk_live_", 16, SecretKind::StripeKey),
    ("rk_live_", 16, SecretKind::StripeKey),
    ("sk-", 20, SecretKind::OpenAiKey),
    ("xoxb-", 12, SecretKind::SlackToken),
    ("xoxp-", 12, SecretKind::SlackToken),
    ("xoxa-", 12, SecretKind::SlackToken),
    ("xoxs-", 12, SecretKind::SlackToken),
    ("xapp-", 12, SecretKind::SlackToken),
    ("AIza", 30, SecretKind::GoogleApiKey),
    ("glpat-", 16, SecretKind::GitLabToken),
    ("hf_", 20, SecretKind::HuggingFaceToken),
    ("npm_", 30, SecretKind::NpmToken),
    ("SG.", 30, SecretKind::SendGridKey),
];

/// Substrings that make an assignment's *name* a secret name. Matched
/// case-insensitively against the name only, never against the value.
const SECRET_NAMES: &[&str] = &[
    "secret",
    "password",
    "passwd",
    "passphrase",
    "api_key",
    "apikey",
    "api-key",
    "access_key",
    "access-key",
    "private_key",
    "private-key",
    "auth_token",
    "authtoken",
    "auth-token",
    "token",
    "credential",
    "session_key",
    "client_secret",
];

/// Names that contain a secret-ish word but never a secret value. Without this,
/// every `--max-tokens 4096` and `token_count = 12` in the codebase reports.
const NAME_EXCEPTIONS: &[&str] = &[
    "max_tokens",
    "max-tokens",
    "maxtokens",
    "token_count",
    "tokencount",
    "num_tokens",
    "n_tokens",
    "tokens_used",
    "token_limit",
    "token_budget",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "cached_tokens",
    "tokenizer",
    "token_type",
    "secret_name",
    "password_field",
];

/// Values that are placeholders, not credentials: already-redacted markers,
/// shell/CI variable references, template holes and empty strings. Redacting
/// these would make output *less* readable for no gain, and reporting them as
/// findings would block diffs that contain nothing.
fn is_placeholder(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() < 6 {
        return true;
    }
    if trimmed.chars().all(|c| c == '*' || c == 'x' || c == 'X' || c == '.') {
        return true;
    }
    // `$VAR`, `${VAR}`, `%VAR%`, `<your-key>`, `{{ secrets.X }}`, `env(...)`.
    let first = trimmed.as_bytes()[0];
    if matches!(first, b'$' | b'%' | b'<' | b'{') {
        return true;
    }
    if trimmed.starts_with("env(") || trimmed.starts_with("REDACTED") {
        return true;
    }
    if trimmed.contains("[redacted") {
        return true;
    }
    // A value that is only punctuation or spaces carries nothing.
    !trimmed.chars().any(|c| c.is_ascii_alphanumeric())
}

/// True while `c` can be part of an opaque credential token.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '=' | '~')
}

/// True when `c` immediately before a match means the match is the tail of a
/// longer word rather than a token of its own -- `task-runner` is not `sk-…`.
///
/// Narrower than [`is_token_char`] on purpose. `=` is a token character because
/// it is base64 padding at the *end* of a value, but it is also the commonest
/// thing to appear immediately *before* one (`AWS_ACCESS_KEY_ID=AKIA…`), so
/// treating it as a word character there would hide every assigned vendor token
/// behind the more generic assignment rule.
fn is_word_char_before(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '~')
}

/// True while `c` can be part of an assignment's name.
fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')
}

/// Every credential in `text`, in order, with overlaps merged.
///
/// Overlapping matches are real and common -- `Authorization: Bearer sk-…` is an
/// authorization header *and* an OpenAI key -- and a caller redacting spans must
/// never be handed two that intersect. When two matches overlap the earlier one
/// wins and the later is dropped, so the widest useful span (the header, the PEM
/// block) is the one reported.
pub fn scan(text: &str) -> Vec<Finding> {
    let mut raw = Vec::new();
    scan_private_keys(text, &mut raw);
    scan_prefixes(text, &mut raw);
    scan_jwts(text, &mut raw);
    scan_authorization(text, &mut raw);
    scan_url_passwords(text, &mut raw);
    scan_assignments(text, &mut raw);

    // Sort by position, then widest-first so the containing span survives the
    // overlap pass below.
    raw.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged: Vec<Finding> = Vec::with_capacity(raw.len());
    for finding in raw {
        match merged.last() {
            Some(last) if finding.start < last.end => continue,
            _ => merged.push(finding),
        }
    }
    // Line numbers are assigned last, once, rather than per rule: computing them
    // inside each scanner would be six passes over the text for no benefit.
    let mut line = 1usize;
    let mut cursor = 0usize;
    for finding in merged.iter_mut() {
        line += text[cursor..finding.start].matches('\n').count();
        cursor = finding.start;
        finding.line = line;
    }
    merged
}

/// True when `text` holds at least one credential. Cheaper to read than
/// `!scan(text).is_empty()` at a call site that only needs the answer.
pub fn contains_secret(text: &str) -> bool {
    !scan(text).is_empty()
}

/// `text` with every credential replaced by `[redacted: <kind>]`.
///
/// Length is not preserved: a redaction that kept the shape of the value would
/// leak the shape of the value. Everything outside the matched spans is returned
/// byte-for-byte, so a redacted log line still reads as the line it was.
pub fn redact(text: &str) -> String {
    let findings = scan(text);
    if findings.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for finding in &findings {
        out.push_str(&text[cursor..finding.start]);
        out.push_str("[redacted: ");
        out.push_str(finding.kind.label());
        out.push(']');
        cursor = finding.end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// PEM private-key blocks, whole. A key body is base64 across many lines, so
/// redacting the armour alone would leave the key itself in the text.
fn scan_private_keys(text: &str, out: &mut Vec<Finding>) {
    const OPEN: &str = "-----BEGIN ";
    let bytes = text.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(OPEN) {
        let start = from + rel;
        let Some(header_end) = text[start..].find("-----\n").map(|i| start + i + 6) else {
            // An unterminated header line: nothing to bound, and no key body has
            // been seen, so leave it alone rather than swallowing the rest.
            break;
        };
        let header = &text[start..header_end];
        if !header.contains("PRIVATE KEY") {
            from = header_end;
            continue;
        }
        // End at the closing armour when there is one, otherwise at the end of
        // the text: a truncated key is still a key.
        let end = match text[header_end..].find("-----END ") {
            Some(i) => {
                let tail = header_end + i;
                match text[tail..].find("-----\n") {
                    Some(j) => tail + j + 5,
                    None => match text[tail..].find("-----") {
                        Some(j) => tail + j + 5,
                        None => bytes.len(),
                    },
                }
            }
            None => bytes.len(),
        };
        out.push(Finding {
            kind: SecretKind::PrivateKey,
            line: 0,
            start,
            end,
        });
        from = end;
    }
}

/// Vendor-prefixed tokens.
fn scan_prefixes(text: &str, out: &mut Vec<Finding>) {
    for (prefix, min_tail, kind) in PREFIXES {
        let mut from = 0usize;
        while let Some(rel) = text[from..].find(prefix) {
            let start = from + rel;
            from = start + prefix.len();
            // Must start a token: `foosk-…` is not a key, and neither is the
            // `sk-` inside `task-runner`.
            if start > 0 {
                let prev = text[..start].chars().next_back().unwrap_or(' ');
                if is_word_char_before(prev) {
                    continue;
                }
            }
            let tail_start = start + prefix.len();
            let tail_len = text[tail_start..]
                .chars()
                .take_while(|c| is_token_char(*c))
                .map(char::len_utf8)
                .sum::<usize>();
            if tail_len < *min_tail {
                continue;
            }
            let end = tail_start + tail_len;
            out.push(Finding {
                kind: *kind,
                line: 0,
                start,
                end,
            });
            from = end;
        }
    }
}

/// JWTs: three dot-separated base64url segments, the first of which decodes to
/// a JSON object -- which in practice means it starts `eyJ`.
fn scan_jwts(text: &str, out: &mut Vec<Finding>) {
    const HEAD: &str = "eyJ";
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(HEAD) {
        let start = from + rel;
        from = start + HEAD.len();
        if start > 0 {
            let prev = text[..start].chars().next_back().unwrap_or(' ');
            if is_word_char_before(prev) {
                continue;
            }
        }
        let len = text[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
            .map(char::len_utf8)
            .sum::<usize>();
        let candidate = &text[start..start + len];
        // Trailing dots belong to the sentence, not the token.
        let candidate = candidate.trim_end_matches('.');
        let parts: Vec<&str> = candidate.split('.').collect();
        if parts.len() != 3 || parts.iter().any(|p| p.len() < 8) {
            continue;
        }
        let end = start + candidate.len();
        out.push(Finding {
            kind: SecretKind::Jwt,
            line: 0,
            start,
            end,
        });
        from = end;
    }
}

/// The credential in an `Authorization:` header or a bare `Bearer <token>`.
///
/// The span covers the credential only, not the header name: a log line that
/// still says `Authorization: [redacted: authorization]` tells the reader what
/// the request did, which is the point of keeping the line at all.
fn scan_authorization(text: &str, out: &mut Vec<Finding>) {
    for scheme in ["Bearer ", "bearer ", "Basic ", "basic ", "Token "] {
        let mut from = 0usize;
        while let Some(rel) = text[from..].find(scheme) {
            let start = from + rel;
            from = start + scheme.len();
            let value_start = start + scheme.len();
            let len = text[value_start..]
                .chars()
                .take_while(|c| is_token_char(*c))
                .map(char::len_utf8)
                .sum::<usize>();
            if len < 8 {
                continue;
            }
            let end = value_start + len;
            if is_placeholder(&text[value_start..end]) {
                continue;
            }
            out.push(Finding {
                kind: SecretKind::AuthorizationHeader,
                line: 0,
                start: value_start,
                end,
            });
            from = end;
        }
    }
}

/// `scheme://user:password@host` -- the password only.
fn scan_url_passwords(text: &str, out: &mut Vec<Finding>) {
    let mut from = 0usize;
    while let Some(rel) = text[from..].find("://") {
        let authority_start = from + rel + 3;
        from = authority_start;
        // The authority ends at the first path, query or whitespace character.
        let authority_len = text[authority_start..]
            .chars()
            .take_while(|c| !c.is_whitespace() && !matches!(c, '/' | '?' | '#' | '"' | '\'' | '`'))
            .map(char::len_utf8)
            .sum::<usize>();
        let authority = &text[authority_start..authority_start + authority_len];
        let Some(at) = authority.rfind('@') else {
            continue;
        };
        let userinfo = &authority[..at];
        let Some(colon) = userinfo.find(':') else {
            continue;
        };
        let start = authority_start + colon + 1;
        let end = authority_start + at;
        if end <= start || is_placeholder(&text[start..end]) {
            continue;
        }
        out.push(Finding {
            kind: SecretKind::UrlPassword,
            line: 0,
            start,
            end,
        });
        from = authority_start + authority_len;
    }
}

/// Assignments whose name says the value is a secret: `API_KEY=…`,
/// `"password": "…"`, `--token …`, `password: …`.
///
/// Scanned per line. A value that runs to the end of the line is what an
/// environment dump and a `.env` file both look like; stopping at a quote or a
/// separator is what a JSON body and a command line look like.
fn scan_assignments(text: &str, out: &mut Vec<Finding>) {
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        scan_assignments_in_line(line, offset, out);
        offset += line.len();
    }
}

fn scan_assignments_in_line(line: &str, offset: usize, out: &mut Vec<Finding>) {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // Find a separator, then read the name backwards from it.
        let c = bytes[i] as char;
        if c != '=' && c != ':' {
            i += 1;
            continue;
        }
        // `::` is a path separator, not an assignment; `:=` and `==` are still
        // assignments/comparisons whose right side may hold the value.
        if c == ':' && (bytes.get(i + 1) == Some(&b':') || (i > 0 && bytes[i - 1] == b':')) {
            i += 1;
            continue;
        }
        // Trailing quotes belong to the syntax, not the name: without trimming
        // them the name of `"password": "..."` reads as empty and the whole
        // assignment is skipped.
        let name_end = line[..i]
            .trim_end()
            .trim_end_matches(|c| c == '"' || c == '\'')
            .len();
        let name_start = line[..name_end]
            .rfind(|ch: char| !is_name_char(ch))
            .map(|p| p + 1)
            .unwrap_or(0);
        let raw_name = &line[name_start..name_end];
        let name = raw_name.trim_matches(|c| c == '"' || c == '\'');
        let lowered = name.to_ascii_lowercase();
        let secret_name = SECRET_NAMES.iter().any(|n| lowered.contains(n))
            && !NAME_EXCEPTIONS.iter().any(|n| lowered.contains(n));
        if !secret_name || name.is_empty() {
            i += 1;
            continue;
        }

        // Skip the separator and any `=`/whitespace/quote that follows it.
        let mut value_start = i + 1;
        while value_start < bytes.len()
            && matches!(bytes[value_start], b' ' | b'\t' | b'=' | b'>' | b'"' | b'\'')
        {
            value_start += 1;
        }
        let opener = bytes[value_start.saturating_sub(1)];
        let closers: &[u8] = match opener {
            b'"' => &[b'"'],
            b'\'' => &[b'\''],
            // Unquoted: stop at anything that ends a shell word or a structure.
            _ => &[b' ', b'\t', b'\n', b'\r', b',', b';', b'}', b']', b')', b'&', b'|'],
        };
        let mut value_end = value_start;
        while value_end < bytes.len() && !closers.contains(&bytes[value_end]) {
            value_end += 1;
        }
        if value_end > value_start && !is_placeholder(&line[value_start..value_end]) {
            out.push(Finding {
                kind: SecretKind::AssignedSecret,
                line: 0,
                start: offset + value_start,
                end: offset + value_end,
            });
        }
        i = value_end.max(i + 1);
    }
}

/// A `--flag value` form of the assignment rule, applied by callers that scan
/// command lines: `--token abc123`. Kept separate from [`scan_assignments`]
/// because a bare space is far too common a separator to treat as an assignment
/// everywhere, but on a command line it is exactly the form used.
pub fn scan_command_line(command: &str) -> Vec<Finding> {
    let mut out = scan(command);
    let bytes = command.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'-' {
            i += 1;
            continue;
        }
        // A flag starts the line or follows whitespace.
        if i > 0 && !bytes[i - 1].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let flag_start = i;
        let mut flag_end = i;
        while flag_end < bytes.len() && (bytes[flag_end] == b'-' || is_name_char(bytes[flag_end] as char)) {
            flag_end += 1;
        }
        let flag = command[flag_start..flag_end].trim_start_matches('-').to_ascii_lowercase();
        i = flag_end;
        let is_secret_flag = SECRET_NAMES.iter().any(|n| flag.contains(n))
            && !NAME_EXCEPTIONS.iter().any(|n| flag.contains(n));
        if !is_secret_flag {
            continue;
        }
        let mut value_start = flag_end;
        while value_start < bytes.len() && matches!(bytes[value_start], b' ' | b'\t' | b'"' | b'\'') {
            value_start += 1;
        }
        let mut value_end = value_start;
        while value_end < bytes.len()
            && !matches!(
                bytes[value_end],
                b' ' | b'\t' | b'\n' | b'"' | b'\'' | b';' | b'&' | b'|'
            )
        {
            value_end += 1;
        }
        if value_end > value_start && !is_placeholder(&command[value_start..value_end]) {
            out.push(Finding {
                kind: SecretKind::AssignedSecret,
                line: 1,
                start: value_start,
                end: value_end,
            });
        }
        i = value_end.max(i);
    }
    out.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged: Vec<Finding> = Vec::with_capacity(out.len());
    for finding in out {
        match merged.last() {
            Some(last) if finding.start < last.end => continue,
            _ => merged.push(finding),
        }
    }
    merged
}

/// [`redact`] for a command line, using [`scan_command_line`]'s wider rules.
pub fn redact_command_line(command: &str) -> String {
    let findings = scan_command_line(command);
    if findings.is_empty() {
        return command.to_string();
    }
    let mut out = String::with_capacity(command.len());
    let mut cursor = 0usize;
    for finding in &findings {
        out.push_str(&command[cursor..finding.start]);
        out.push_str("[redacted: ");
        out.push_str(finding.kind.label());
        out.push(']');
        cursor = finding.end;
    }
    out.push_str(&command[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The value must not survive anywhere in the output. Asserted on every
    /// positive case: a redactor that leaves the secret in a second copy of the
    /// line (a "context" field, a duplicated message) is not a redactor.
    fn assert_redacted(text: &str, secret: &str, kind: SecretKind) {
        let out = redact(text);
        assert!(
            !out.contains(secret),
            "secret survived redaction: {out} (looking for {secret})"
        );
        assert!(
            out.contains(kind.label()),
            "marker missing for {}: {out}",
            kind.label()
        );
    }

    #[test]
    fn detects_vendor_prefixed_tokens() {
        let cases: &[(&str, SecretKind)] = &[
            ("AKIAIOSFODNN7EXAMPLE", SecretKind::AwsAccessKeyId),
            ("ghp_1234567890abcdefghijklmnopqrstuvwx", SecretKind::GitHubToken),
            (
                "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890",
                SecretKind::GitHubToken,
            ),
            ("sk-ant-api03-abcdefghijklmnopqrstuvwxyz", SecretKind::AnthropicKey),
            ("sk-abcdefghijklmnopqrstuvwxyz012345", SecretKind::OpenAiKey),
            ("xoxb-123456789012-abcdefghijkl", SecretKind::SlackToken),
            ("AIzaSyA1234567890abcdefghijklmnopqrstuvw", SecretKind::GoogleApiKey),
            ("glpat-abcdefghijklmnopqrst", SecretKind::GitLabToken),
            ("hf_abcdefghijklmnopqrstuvwxyz", SecretKind::HuggingFaceToken),
        ];
        for (secret, kind) in cases {
            let line = format!("export KEY_HOLDER=\"{secret}\" # note");
            let findings = scan(&line);
            assert!(
                findings.iter().any(|f| f.kind == *kind),
                "{secret} not detected as {kind:?}: {findings:?}"
            );
            assert_redacted(&line, secret, *kind);
        }
    }

    /// An assigned vendor token must be reported as that vendor's kind, not as a
    /// generic assignment: the label is what a reader of a redacted log has to go
    /// on, and `=` immediately before the token must not hide it.
    #[test]
    fn an_assigned_vendor_token_keeps_its_own_kind() {
        let findings = scan("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].kind, SecretKind::AwsAccessKeyId);
        assert!(redact("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")
            .contains("[redacted: aws-access-key-id]"));
    }

    #[test]
    fn anthropic_prefix_wins_over_openai() {
        let findings = scan("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, SecretKind::AnthropicKey);
    }

    #[test]
    fn ignores_prefixes_inside_words() {
        // `task-runner` contains `sk-`, and a 20-character tail; it must not
        // report, because the prefix does not start the token.
        assert!(scan("the task-runner-abcdefghijklmnopqrstuvwxyz path").is_empty());
    }

    #[test]
    fn redacts_a_private_key_block_whole() {
        let text = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nqqqqqqqqqqqq\n-----END RSA PRIVATE KEY-----\nafter\n";
        let out = redact(text);
        assert!(!out.contains("MIIEowIBAAKCAQEA"), "{out}");
        assert!(!out.contains("qqqqqqqqqqqq"), "{out}");
        assert!(out.starts_with("before\n"), "{out}");
        assert!(out.trim_end().ends_with("after"), "{out}");
    }

    #[test]
    fn redacts_an_unterminated_private_key_to_the_end() {
        let text = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n";
        let out = redact(text);
        assert!(!out.contains("b3BlbnNzaC1rZXktdjEAAAAA"), "{out}");
    }

    #[test]
    fn leaves_a_public_key_block_alone() {
        let text = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----\n";
        assert_eq!(redact(text), text);
    }

    #[test]
    fn detects_a_jwt_but_not_a_dotted_word() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let findings = scan(jwt);
        assert!(findings.iter().any(|f| f.kind == SecretKind::Jwt), "{findings:?}");
        // Inside a secret-named assignment the wider span wins, but the value
        // still goes; which rule caught it is not the guarantee that matters.
        assert!(!redact(&format!("token={jwt}")).contains(jwt));
        assert!(scan("eyJa.b.c").is_empty());
    }

    #[test]
    fn redacts_an_authorization_header_without_losing_the_header() {
        let out = redact("Authorization: Bearer abcdefghijklmnopqrstuv");
        assert!(out.starts_with("Authorization: Bearer "), "{out}");
        assert!(!out.contains("abcdefghijklmnopqrstuv"), "{out}");
    }

    #[test]
    fn redacts_a_url_password_only() {
        let out = redact("git clone https://alice:s3cr3t-p4ssw0rd@example.com/repo.git");
        assert!(out.contains("https://alice:"), "{out}");
        assert!(out.contains("@example.com/repo.git"), "{out}");
        assert!(!out.contains("s3cr3t-p4ssw0rd"), "{out}");
    }

    #[test]
    fn leaves_a_url_without_userinfo_alone() {
        let text = "https://example.com/a/b?c=d";
        assert_eq!(redact(text), text);
    }

    #[test]
    fn redacts_secret_named_assignments_in_several_shapes() {
        for (text, secret) in [
            ("API_KEY=aabbccddeeff00112233", "aabbccddeeff00112233"),
            ("  \"password\": \"correct-horse-battery\",", "correct-horse-battery"),
            ("client_secret: 9f8e7d6c5b4a39281706", "9f8e7d6c5b4a39281706"),
            ("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG", "wJalrXUtnFEMI/K7MDENG"),
        ] {
            let out = redact(text);
            assert!(!out.contains(secret), "secret survived: {out}");
            assert!(out.contains("[redacted: secret]"), "{out}");
        }
    }

    #[test]
    fn does_not_report_token_counters_or_placeholders() {
        for text in [
            "max_tokens=4096",
            "total_tokens: 1288",
            "API_KEY=$OPENAI_KEY",
            "password: ${DB_PASSWORD}",
            "token = \"***\"",
            "api_key: <your-key-here>",
            "AUTH_TOKEN={{ secrets.AUTH_TOKEN }}",
            "password=",
        ] {
            assert!(scan(text).is_empty(), "false positive on: {text} -> {:?}", scan(text));
        }
    }

    #[test]
    fn is_idempotent() {
        let once = redact("API_KEY=aabbccddeeff00112233");
        assert_eq!(redact(&once), once);
    }

    #[test]
    fn keeps_everything_that_is_not_a_secret_byte_for_byte() {
        let text = "git status --porcelain\nfn main() { println!(\"hi\"); }\nsha=9fceb02d\n";
        assert_eq!(redact(text), text);
    }

    #[test]
    fn command_line_flags_carry_their_value_away() {
        let out = redact_command_line("curl -X POST --token abcdef1234567890 https://example.com");
        assert!(!out.contains("abcdef1234567890"), "{out}");
        assert!(out.contains("--token [redacted: secret]"), "{out}");
        assert!(out.contains("https://example.com"), "{out}");
    }

    #[test]
    fn overlapping_matches_never_produce_overlapping_spans() {
        // The header rule and the OpenAI rule both match here.
        let findings = scan("Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz");
        for pair in findings.windows(2) {
            assert!(pair[0].end <= pair[1].start, "overlap: {findings:?}");
        }
        let out = redact("Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz");
        assert!(!out.contains("sk-abcdefghijklmnopqrstuvwxyz"), "{out}");
    }

    #[test]
    fn reports_the_line_a_finding_is_on() {
        let text = "clean\nclean\nAPI_KEY=aabbccddeeff00112233\n";
        let findings = scan(text);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].line, 3);
        assert_eq!(findings[0].describe(), "secret at line 3");
    }

    #[test]
    fn multibyte_text_slices_on_character_boundaries() {
        let text = "コメント API_KEY=aabbccddeeff00112233 終わり";
        let out = redact(text);
        assert!(out.starts_with("コメント "), "{out}");
        assert!(out.ends_with(" 終わり"), "{out}");
        assert!(!out.contains("aabbccddeeff00112233"), "{out}");
    }
}
