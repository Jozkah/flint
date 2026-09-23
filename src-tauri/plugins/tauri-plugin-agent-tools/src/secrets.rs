//! Finding credentials in text, and keeping them out of what is kept.
//! AH-045 / AH-157.
//!
//! Two jobs that share one detector. Before a diff is shown or applied, a
//! secret in it is worth stopping for: a key committed by accident is a key
//! that has to be rotated, and the moment to catch it is before it is written.
//! Before anything is persisted or rendered, a secret in it is worth removing:
//! a transcript, an audit line and an error message all outlive the session.
//!
//! Deliberately conservative about what it calls a secret, and deliberately
//! blunt about what it does with one. A false positive costs someone an
//! explanation; a false negative writes a live credential into a file that
//! gets shared.

use serde::{Deserialize, Serialize};

/// What kind of credential was found. Named, because the remedy differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretKind {
    PrivateKey,
    ApiKey,
    Token,
    Password,
    ConnectionString,
}

impl SecretKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SecretKind::PrivateKey => "private key",
            SecretKind::ApiKey => "API key",
            SecretKind::Token => "token",
            SecretKind::Password => "password",
            SecretKind::ConnectionString => "connection string",
        }
    }
}

/// One find. Carries where it was, never what it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretFinding {
    pub kind: SecretKind,
    /// 1-based line within the text scanned.
    pub line: usize,
    /// The file the line belongs to, when scanning a diff.
    #[serde(default)]
    pub file: String,
    /// A few characters of context with the value itself masked, so a person
    /// can find the line without the finding becoming a second copy of the
    /// secret.
    pub hint: String,
}

const REDACTED: &str = "[redacted]";

/// Does this line carry a credential, and of what kind?
///
/// Matched on shape rather than on a list of vendors: an assignment whose name
/// says "secret" and whose value looks like one, a PEM header, a URL with a
/// password in it. A vendor list ages badly and misses the in-house token
/// nobody registered.
fn classify_line(line: &str) -> Option<(SecretKind, String)> {
    // One diff marker, not every leading dash: stripping them all turns a PEM
    // header into ordinary text and the detector walks straight past a private
    // key, which is the single worst thing it could miss.
    let body = line
        .strip_prefix('+')
        .or_else(|| line.strip_prefix('-'))
        .unwrap_or(line);
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();

    if lower.contains("begin") && lower.contains("private key") {
        return Some((
            SecretKind::PrivateKey,
            "-----BEGIN … PRIVATE KEY-----".into(),
        ));
    }

    // scheme://user:password@host
    if let Some(at) = trimmed.find('@') {
        let head = &trimmed[..at];
        if head.contains("://") && head.rsplit("://").next().is_some_and(|c| c.contains(':')) {
            return Some((SecretKind::ConnectionString, mask_after(trimmed, "://")));
        }
    }

    // A credential written into a sentence.
    //
    // Everything above this point needs the credential to be *shaped* like
    // something -- an assignment, a URL, a PEM header. That is the right model
    // for a diff or a config file, which is what this scanner was built for.
    // It is the wrong model for prose, and memory content is prose: "The API
    // key is sk-live-..." has no `NAME =` anywhere in it, so it walked straight
    // through and was stored verbatim. Found by a test asserting that
    // automatic memory saving refuses a secret; it did not.
    if let Some(found) = token_like(trimmed) {
        return Some(found);
    }

    // NAME = value, where the name says what the value is.
    let (name, value) = split_assignment(trimmed)?;
    let value = value.trim().trim_matches(['"', '\'']).trim();
    if value.is_empty() || value.len() < 8 {
        return None;
    }
    // A placeholder is not a secret, and flagging one trains people to ignore
    // the warning that matters.
    let placeholder = value.to_ascii_lowercase();
    if placeholder.contains("example")
        || placeholder.contains("changeme")
        || placeholder.contains("your-")
        || placeholder.starts_with("${")
        || placeholder.starts_with("<")
        || placeholder.chars().all(|c| c == 'x' || c == '*')
    {
        return None;
    }

    let name = name.to_ascii_lowercase();
    let kind = secret_name_kind(&name)?;
    Some((kind, format!("{name}={REDACTED}")))
}

/// Whether a lowercase value name says the value is a credential, and which.
fn secret_name_kind(name: &str) -> Option<SecretKind> {
    let kind = if name.contains("private_key") || name.contains("privatekey") {
        SecretKind::PrivateKey
    } else if name.contains("password") || name.contains("passwd") {
        SecretKind::Password
    } else if name.contains("token") {
        SecretKind::Token
    } else if name.contains("api_key")
        || name.contains("apikey")
        || name.contains("secret")
        || name.contains("access_key")
    {
        SecretKind::ApiKey
    } else if name.contains("authorization")
        || name.ends_with("auth")
        || name.contains("proxy-authorization")
    {
        // `Authorization: Bearer …` and `Authorization: Basic …` are the most
        // common way a credential appears in tool output and in anything
        // pasted from a terminal, and the header's name says nothing about
        // tokens or keys -- so the rules above walked straight past it.
        SecretKind::Token
    } else {
        return None;
    };
    Some(kind)
}

/// Whether a value is a stand-in rather than a credential.
fn is_placeholder(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("example")
        || lower.contains("changeme")
        || lower.contains("your-")
        || lower.starts_with("${")
        || lower.starts_with('<')
        || lower.chars().all(|c| c == 'x' || c == '*')
}

/// Replace the value of every `name = value` / `"name": "value"` on the line
/// whose name says it is a credential (Jozkah/jan#277). The word pass only
/// knows credentials by shape; a password has none, so on a line that also
/// held a shaped token it used to survive. `None` when nothing changed.
fn redact_named_values(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut copied = 0;
    let mut changed = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'=' && bytes[i] != b':' {
            i += 1;
            continue;
        }
        // The name: identifier characters just before the separator, past a
        // closing quote and spaces.
        let mut end = i;
        while end > 0 && matches!(bytes[end - 1], b' ' | b'\t' | b'"' | b'\'') {
            end -= 1;
        }
        let mut start = end;
        while start > 0
            && (bytes[start - 1].is_ascii_alphanumeric() || matches!(bytes[start - 1], b'_' | b'-' | b'.'))
        {
            start -= 1;
        }
        let name = line[start..end].to_ascii_lowercase();
        // The value: after spaces and an optional opening quote, up to the
        // matching quote or the first delimiter.
        let mut v = i + 1;
        while v < bytes.len() && matches!(bytes[v], b' ' | b'\t') {
            v += 1;
        }
        let quote = bytes.get(v).copied().filter(|b| *b == b'"' || *b == b'\'');
        if quote.is_some() {
            v += 1;
        }
        let mut w = v;
        while w < bytes.len() {
            let b = bytes[w];
            let stop = match quote {
                Some(q) => b == q,
                None => b.is_ascii_whitespace() || matches!(b, b',' | b'}' | b';' | b'&' | b'"' | b'\''),
            };
            if stop {
                break;
            }
            w += 1;
        }
        let value = &line[v..w];
        if !name.is_empty()
            && secret_name_kind(&name).is_some()
            && value.len() >= 8
            && !value.contains(REDACTED)
            && !is_placeholder(value)
        {
            out.push_str(&line[copied..v]);
            out.push_str(REDACTED);
            copied = w;
            changed = true;
        }
        i = w.max(i + 1);
    }
    if !changed {
        return None;
    }
    out.push_str(&line[copied..]);
    Some(out)
}

/// Issued-credential prefixes, and how much must follow to be one.
///
/// Prefix plus a length floor rather than a full character-class pattern: these
/// are vendor-assigned shapes, so the prefix is the evidence and the length is
/// what separates a real key from someone typing `sk-` in a sentence about
/// keys. Deliberately conservative -- a missed credential is a stored
/// credential, but a false positive here refuses to remember something
/// harmless, so the floors are set where prose does not reach.
const ISSUED_PREFIXES: &[(&str, usize, SecretKind)] = &[
    // OpenAI, Stripe and everything that copied them.
    ("sk-", 20, SecretKind::ApiKey),
    ("pk-live-", 20, SecretKind::ApiKey),
    ("rk-live-", 20, SecretKind::ApiKey),
    // GitHub, all five token classes.
    ("ghp_", 30, SecretKind::Token),
    ("gho_", 30, SecretKind::Token),
    ("ghu_", 30, SecretKind::Token),
    ("ghs_", 30, SecretKind::Token),
    ("ghr_", 30, SecretKind::Token),
    // Slack.
    ("xoxb-", 24, SecretKind::Token),
    ("xoxp-", 24, SecretKind::Token),
    ("xoxa-", 24, SecretKind::Token),
    ("xoxs-", 24, SecretKind::Token),
    // AWS access key id.
    ("AKIA", 20, SecretKind::ApiKey),
    ("ASIA", 20, SecretKind::ApiKey),
    // Google.
    ("AIza", 35, SecretKind::ApiKey),
    // Anthropic.
    ("sk-ant-", 30, SecretKind::ApiKey),
];

/// A credential recognisable by its own shape, anywhere in a line.
fn token_like(line: &str) -> Option<(SecretKind, String)> {
    // `Bearer <token>` and `Basic <token>` carry no variable name at all, and
    // are how a credential most often appears in pasted terminal output.
    let lower = line.to_ascii_lowercase();
    for scheme in ["bearer ", "basic "] {
        if let Some(at) = lower.find(scheme) {
            let rest = line[at + scheme.len()..].trim();
            let token: &str = rest.split_whitespace().next().unwrap_or("");
            if token.len() >= 16 {
                return Some((SecretKind::Token, format!("{scheme}{REDACTED}")));
            }
        }
    }

    for word in line.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',') {
        // Punctuation a sentence puts after a value, not part of it.
        let word = word.trim_end_matches(['.', ';', ':', ')', ']', '}']);
        if word.len() < 16 {
            continue;
        }
        // A JWT: three base64url segments, and the header always starts `eyJ`.
        if word.starts_with("eyJ") && word.matches('.').count() == 2 {
            return Some((SecretKind::Token, format!("jwt {REDACTED}")));
        }
        for (prefix, min_len, kind) in ISSUED_PREFIXES {
            if word.len() >= *min_len && word.starts_with(prefix) {
                return Some((*kind, format!("{prefix}{REDACTED}")));
            }
        }
    }
    None
}

fn split_assignment(line: &str) -> Option<(&str, &str)> {
    for separator in ['=', ':'] {
        if let Some(at) = line.find(separator) {
            let (head, value) = line.split_at(at);
            // The last token before the separator is the name: `const
            // STRIPE_SECRET = ...` and `export API_KEY=...` both name the
            // thing being set, and requiring the whole left side to look like
            // an identifier missed every declaration with a keyword in front
            // of it.
            let name = head
                .trim()
                .rsplit([' ', '\t'])
                .next()
                .unwrap_or("")
                .trim_matches(['"', '\'', ',', '(', '{'])
                .trim();
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
            {
                return Some((name, &value[1..]));
            }
        }
    }
    None
}

fn mask_after(line: &str, marker: &str) -> String {
    match line.find(marker) {
        Some(at) => format!("{}{marker}{REDACTED}", &line[..at]),
        None => REDACTED.to_string(),
    }
}

/// Scan plain text. Line numbers are 1-based.
pub fn scan_text(text: &str) -> Vec<SecretFinding> {
    text.lines()
        .enumerate()
        .filter_map(|(i, line)| {
            classify_line(line).map(|(kind, hint)| SecretFinding {
                kind,
                line: i + 1,
                file: String::new(),
                hint,
            })
        })
        .collect()
}

/// Scan a unified diff, reporting only what the change *adds*. AH-157.
///
/// A secret on a removed line is a secret being taken out, which is the thing
/// we want people doing. Reporting it would make the warning fire on the fix.
pub fn scan_diff(diff: &str) -> Vec<SecretFinding> {
    let mut findings = Vec::new();
    let mut file = String::new();
    let mut line_no = 0usize;

    for raw in diff.lines() {
        if let Some(path) = raw.strip_prefix("+++ ") {
            file = path.trim_start_matches("b/").trim().to_string();
            line_no = 0;
            continue;
        }
        if raw.starts_with("--- ") || raw.starts_with("diff ") || raw.starts_with("index ") {
            continue;
        }
        if raw.starts_with("@@") {
            line_no = hunk_start(raw).unwrap_or(0);
            continue;
        }
        if raw.starts_with('-') {
            continue;
        }
        if let Some(added) = raw.strip_prefix('+') {
            line_no += 1;
            if let Some((kind, hint)) = classify_line(added) {
                findings.push(SecretFinding {
                    kind,
                    line: line_no,
                    file: file.clone(),
                    hint,
                });
            }
            continue;
        }
        line_no += 1;
    }

    findings
}

/// The new-file starting line of a hunk header: `@@ -a,b +c,d @@`.
fn hunk_start(header: &str) -> Option<usize> {
    let plus = header.split('+').nth(1)?;
    let number: String = plus.chars().take_while(|c| c.is_ascii_digit()).collect();
    number.parse::<usize>().ok().map(|n| n.saturating_sub(1))
}

/// Replace credentials in text with a marker, keeping the shape of the line.
/// AH-045.
///
/// Applied before anything is persisted or rendered. The line stays legible --
/// which key was set, and where -- because a redaction that removes the whole
/// line loses the part that was worth keeping.
pub fn redact_secrets(text: &str) -> String {
    text.lines()
        // The word-level pass first, wherever it can do the job: it replaces
        // the credential and leaves the rest of the line standing. Falling back
        // to the line-level pass matters for the shape configuration has, where
        // the value need not look like anything in particular -- `PASSWORD =
        // hunter2` is a secret that no shape rule can recognise, and there the
        // only safe move is to take the whole value.
        //
        // Ordering them the other way round is what made this wrong before:
        // `classify_line` recognises a credential in prose too, and answering
        // it with `redact_line` threw away the sentence that said where the
        // credential came from.
        .map(|line| match classify_line(line) {
            // A shaped token was replaced, but a named secret without a shape
            // can share its line (Jozkah/jan#277): take those values too.
            Some((_, _)) => match redact_tokens_in_line(line) {
                Some(rebuilt) => redact_named_values(&rebuilt).unwrap_or(rebuilt),
                None => redact_line(line),
            },
            None => redact_tokens_in_line(line).unwrap_or_else(|| line.to_string()),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Replace credentials sitting in prose, leaving the rest of the line alone.
///
/// `None` when the line holds none, so the caller can keep the original string
/// rather than a rebuilt copy of it.
///
/// Every match keeps its prefix (`sk-live-[redacted]`), because which kind of
/// credential leaked is exactly what someone reading this later needs to know,
/// and the prefix alone identifies nobody.
fn redact_tokens_in_line(line: &str) -> Option<String> {
    let is_sep = |c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',';
    let mut out = String::with_capacity(line.len());
    let mut changed = false;
    // `Bearer <token>` and `Basic <token>` carry no variable name and no
    // recognisable prefix of their own: the scheme word in front is the only
    // thing that marks the next word as a credential.
    let mut after_scheme = false;
    let mut index = 0;

    while index < line.len() {
        let rest = &line[index..];
        let separators: usize = rest
            .chars()
            .take_while(|c| is_sep(*c))
            .map(char::len_utf8)
            .sum();
        if separators > 0 {
            out.push_str(&rest[..separators]);
            index += separators;
            continue;
        }
        let length: usize = rest
            .chars()
            .take_while(|c| !is_sep(*c))
            .map(char::len_utf8)
            .sum();
        let word = &rest[..length];

        match redacted_word(word, after_scheme) {
            Some(replacement) => {
                out.push_str(&replacement);
                changed = true;
            }
            None => out.push_str(word),
        }
        after_scheme = matches!(
            word.trim_end_matches(':').to_ascii_lowercase().as_str(),
            "bearer" | "basic"
        );
        index += length;
    }

    changed.then_some(out)
}

/// One word, replaced when it is a credential by its own shape.
///
/// Sentence punctuation after the value is kept, so a redacted line still reads
/// as a line; the value itself never survives.
fn redacted_word(word: &str, after_scheme: bool) -> Option<String> {
    let trimmed = word.trim_end_matches(['.', ';', ':', ')', ']', '}']);
    let tail = &word[trimmed.len()..];
    // Sixteen characters is the shortest of the issued formats below. Shorter
    // than that and a match would be a coincidence, not a credential.
    if trimmed.len() < 16 {
        return None;
    }
    if after_scheme {
        return Some(format!("{REDACTED}{tail}"));
    }
    // A JWT: three base64url segments, and the header always starts `eyJ`.
    if trimmed.starts_with("eyJ") && trimmed.matches('.').count() == 2 {
        return Some(format!("{REDACTED}{tail}"));
    }
    for (prefix, min_len, _) in ISSUED_PREFIXES {
        if trimmed.len() >= *min_len && trimmed.starts_with(prefix) {
            return Some(format!("{prefix}{REDACTED}{tail}"));
        }
    }
    None
}

fn redact_line(line: &str) -> String {
    // Only a diff marker and indentation count as leading here: a PEM header
    // is all dashes, and treating those as a prefix would leave the header in
    // place and redact nothing.
    let marker = if line.starts_with('+') || line.starts_with('-') {
        // A PEM header starts with five dashes; a diff marker is one.
        if line.starts_with("--") {
            ""
        } else {
            &line[..1]
        }
    } else {
        ""
    };
    let rest = &line[marker.len()..];
    let indent: String = rest.chars().take_while(|c| c.is_whitespace()).collect();
    let leading = format!("{marker}{indent}");
    let body = &line[leading.len()..];
    match split_assignment(body) {
        Some((name, _)) => format!("{leading}{name}={REDACTED}"),
        None => format!("{leading}{REDACTED}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Jozkah/jan#277: a shaped token on a line must not stop the assignment
    /// secret next to it from being redacted.
    #[test]
    fn an_assignment_secret_next_to_a_token_is_still_redacted() {
        for line in [
            r#"{"api_key":"sk-live-abcdefghijklmnopqrstuv","db_password":"hunter2seventeen"}"#,
            "token: ghp_9d7f6a5b4c3e2d1f0a9b8c7d password: hunter2seventeen",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 DB_PASSWORD=hunter2seventeen",
        ] {
            let out = redact_secrets(line);
            assert!(!out.contains("hunter2seventeen"), "{out}");
            assert!(!out.contains("abcdefghijklmnopqrstuv"), "{out}");
            assert!(!out.contains("9d7f6a5b4c3e2d1f0a9b8c7d"), "{out}");
        }
    }

    #[test]
    fn finds_the_shapes_a_credential_actually_takes() {
        let findings = scan_text(
            "API_KEY = \"sk-live-2f8a91bd77\"\n\
             db_password: hunter2seventeen\n\
             AUTH_TOKEN=ghp_9d7f6a5b4c3e2d1f0a9b\n\
             -----BEGIN RSA PRIVATE KEY-----\n\
             DATABASE_URL=postgres://admin:s3cr3tvalue@db.internal/app\n",
        );
        let kinds: Vec<_> = findings.iter().map(|f| f.kind).collect();
        assert!(kinds.contains(&SecretKind::ApiKey));
        assert!(kinds.contains(&SecretKind::Password));
        assert!(kinds.contains(&SecretKind::Token));
        assert!(kinds.contains(&SecretKind::PrivateKey));
        assert!(kinds.contains(&SecretKind::ConnectionString));
    }

    /// A credential in a sentence, which is what memory content looks like.
    /// Everything else in this scanner needs an assignment, a URL or a PEM
    /// header; prose has none of those, so these went straight through and
    /// were stored.
    #[test]
    fn finds_an_issued_credential_written_into_prose() {
        for line in [
            "The API key is sk-live-abcdefghijklmnopqrstuvwxyz012345.",
            "use ghp_9d7f6a5b4c3e2d1f0a9b8c7d6e5f4a3b2c1d0e when pushing",
            "token: xoxb-123456789012-abcdefghijklmnopqrst",
            "the id is AKIAIOSFODNN7EXAMPLE",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
            "anthropic key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(
                !scan_text(line).is_empty(),
                "missed a credential in: {line}"
            );
        }
    }

    #[test]
    fn a_prose_finding_does_not_repeat_the_credential() {
        let findings = scan_text("The API key is sk-live-abcdefghijklmnopqrstuvwxyz012345.");
        assert_eq!(findings.len(), 1);
        assert!(!findings[0].hint.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(findings[0].hint.contains(REDACTED));
    }

    /// The other half: refusing to remember something harmless is a real cost,
    /// so ordinary sentences that merely mention keys stay quiet.
    #[test]
    fn ordinary_prose_about_keys_is_not_a_credential() {
        for line in [
            "The user prefers tabs over spaces.",
            "Ask for the API key before deploying.",
            "sk- is the prefix OpenAI uses",
            "the bearer of this note may enter",
            "Set AWS_PROFILE to the one named production.",
            "documentation lives at https://example.com/api-keys",
        ] {
            assert!(scan_text(line).is_empty(), "cried wolf over: {line}");
        }
    }

    #[test]
    fn a_finding_never_carries_the_secret_it_found() {
        let findings = scan_text("API_KEY = \"sk-live-2f8a91bd77\"");
        assert_eq!(findings.len(), 1);
        assert!(!findings[0].hint.contains("sk-live-2f8a91bd77"));
        assert!(findings[0].hint.contains("[redacted]"));
    }

    #[test]
    fn does_not_cry_wolf_over_a_placeholder() {
        let quiet = scan_text(
            "API_KEY=your-key-here\n\
             PASSWORD=changeme\n\
             TOKEN=${VAULT_TOKEN}\n\
             SECRET=<fill this in>\n\
             api_key=xxxxxxxxxx\n\
             timeout = 30\n\
             name = \"a-real-project-name\"\n",
        );
        assert_eq!(quiet, Vec::new(), "{quiet:?}");
    }

    #[test]
    fn reports_what_a_diff_adds_and_not_what_it_removes() {
        let diff = "\
--- a/.env
+++ b/.env
@@ -1,2 +1,2 @@
-API_KEY=sk-old-8a7b6c5d4e
+API_KEY=sk-new-1f2e3d4c5b
";
        let findings = scan_diff(diff);
        // The removal is someone taking a key out. Flagging it would fire the
        // warning on the fix.
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].file, ".env");
        assert!(!findings[0].hint.contains("sk-new"));
    }

    #[test]
    fn names_the_file_a_finding_is_in() {
        let diff = "\
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,0 +11,1 @@
+const STRIPE_SECRET = 'sk_live_51H8xQ2eZvKYlo2C'
";
        let findings = scan_diff(diff);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].file, "src/config.ts");
        assert_eq!(findings[0].line, 11);
    }

    /// The case tool output actually produces. A credential in a sentence is
    /// not an assignment, so the line-level pass declines it -- and before the
    /// word-level pass existed, that meant it went into the transcript intact.
    #[test]
    fn a_credential_in_prose_is_redacted() {
        let out = redact_secrets(
            "Authenticated with sk-live-abcdefghijklmnopqrstuvwxyz012345 successfully.",
        );
        assert!(!out.contains("abcdefghijklmnopqrstuvwxyz"), "{out}");
        assert!(out.contains("[redacted]"), "{out}");
        // The sentence survives: which kind of credential leaked, and where, is
        // the part worth keeping.
        assert!(out.starts_with("Authenticated with sk-"), "{out}");
        assert!(out.ends_with("successfully."), "{out}");
    }

    #[test]
    fn an_authorization_header_in_output_is_redacted() {
        let out = redact_secrets("< Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
        assert!(!out.contains("abcdefghijklmnopqrstuvwxyz"), "{out}");
        assert!(out.contains("[redacted]"), "{out}");
    }

    #[test]
    fn a_jwt_in_output_is_redacted() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rXwW1gFWFOEjXk";
        let out = redact_secrets(&format!("the response carried {jwt} in the body"));
        assert!(!out.contains("dBjftJeZ4CVPmB92K27uhbUJU1p1r"), "{out}");
        assert!(out.contains("[redacted]"), "{out}");
    }

    /// The other half, and the one that decides whether anybody leaves this
    /// turned on. A redactor that eats ordinary output protects nothing,
    /// because it gets switched off.
    #[test]
    fn ordinary_output_is_left_exactly_as_it_was() {
        let text = concat!(
            "Compiling jan v0.1.0\n",
            "  Finished in 12.34s\n",
            "file: src/main.rs:42:8\n",
            "https://example.com/a/very/long/path/that/is/not/a/credential\n",
            "hash 9f8e7d6c5b4a39281706f5e4d3c2b1a0"
        );
        assert_eq!(redact_secrets(text), text);
    }

    /// Several on one line, and the line still reads.
    #[test]
    fn every_credential_on_a_line_is_replaced_not_just_the_first() {
        let out = redact_secrets(
            "keys: ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAIOSFODNN7EXAMPLE done",
        );
        assert!(!out.contains("abcdefghijklmnopqrstuvwxyz"), "{out}");
        assert!(!out.contains("IOSFODNN7EXAMPLE"), "{out}");
        assert!(out.ends_with(" done"), "{out}");
    }

    #[test]
    fn redaction_keeps_the_line_legible_and_loses_the_value() {
        let redacted = redact_secrets("API_KEY = \"sk-live-2f8a91bd77\"\nport = 8080\n");
        assert!(redacted.contains("api_key=[redacted]") || redacted.contains("API_KEY=[redacted]"));
        assert!(!redacted.contains("sk-live-2f8a91bd77"));
        // Everything else is left exactly as it was.
        assert!(redacted.contains("port = 8080"));
    }

    #[test]
    fn redacts_a_private_key_header_line() {
        let redacted = redact_secrets("-----BEGIN OPENSSH PRIVATE KEY-----");
        assert!(!redacted.contains("BEGIN"));
    }

    #[test]
    fn an_empty_scan_is_empty_rather_than_an_error() {
        assert!(scan_text("").is_empty());
        assert!(scan_diff("").is_empty());
    }
}
