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

    Some((kind, format!("{name}={REDACTED}")))
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
        .map(|line| match classify_line(line) {
            None => line.to_string(),
            Some((_, _)) => redact_line(line),
        })
        .collect::<Vec<_>>()
        .join("\n")
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
