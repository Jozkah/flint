//! A cheap structural parse check for the files the agent just wrote.
//!
//! After `write` or `edit` changes a `.json`, `.toml` or `.yaml`/`.yml` file,
//! the result the model reads gets one warning line if the file no longer
//! parses, so a missing comma is seen on the next turn instead of at the next
//! build. Nothing is said when the file is fine, and nothing here can fail the
//! tool call: the check only ever produces text.
//!
//! Deliberately small: strict `.json` only (not `.jsonc`), parsers this crate
//! already depends on, no grammar for source code.

use std::path::Path;

/// Files larger than this are not checked: a lockfile-sized document is not
/// something to parse on every edit, and the check must stay cheap.
pub const MAX_CHECK_BYTES: usize = 2 * 1024 * 1024;

/// Longest error text kept in the warning.
const MAX_MESSAGE_CHARS: usize = 200;

/// Whether the extension is one this module parses.
pub fn is_checked(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("json" | "toml" | "yaml" | "yml")
    )
}

/// `Some(warning)` when `path` has a checked extension and `text` does not
/// parse as that format. `None` for a file that parses, an unchecked
/// extension, or text over [`MAX_CHECK_BYTES`].
pub fn check(path: &Path, text: &str) -> Option<String> {
    if text.len() > MAX_CHECK_BYTES {
        return None;
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let why = match ext.as_str() {
        "json" => serde_json::from_str::<serde::de::IgnoredAny>(text)
            .err()
            .map(|e| e.to_string()),
        "toml" => toml::from_str::<toml::Table>(text)
            .err()
            .map(|e| toml_message(&e, text)),
        "yaml" | "yml" => yaml_error(text),
        _ => None,
    }?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    Some(format!(
        "WARNING: {name} does not parse after this change: {}. Fix it before moving on.",
        one_line(&why)
    ))
}

/// [`check`] behind the `[tools] check_syntax` switch.
pub fn check_if(enabled: bool, path: &Path, text: &str) -> Option<String> {
    if enabled {
        check(path, text)
    } else {
        None
    }
}

/// Every document in the stream, so a multi-document file is not reported as
/// broken for being a multi-document file.
fn yaml_error(text: &str) -> Option<String> {
    use serde::Deserialize;
    for doc in serde_yaml::Deserializer::from_str(text) {
        if let Err(e) = serde_yaml::Value::deserialize(doc) {
            return Some(e.to_string());
        }
    }
    None
}

/// The `toml` error's own Display is a multi-line snippet; keep its message
/// and add the line and column worked out from the span.
fn toml_message(e: &toml::de::Error, text: &str) -> String {
    match e.span() {
        Some(span) => {
            let start = span.start.min(text.len());
            let before = &text.as_bytes()[..start];
            let line = before.iter().filter(|b| **b == b'\n').count() + 1;
            let col = start - before.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1) + 1;
            format!("{} at line {line} column {col}", e.message())
        }
        None => e.message().to_string(),
    }
}

fn one_line(s: &str) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_MESSAGE_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(MAX_MESSAGE_CHARS).collect();
    format!("{cut}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_files_say_nothing() {
        assert_eq!(check(Path::new("a.json"), r#"{"a": [1, 2]}"#), None);
        assert_eq!(check(Path::new("a.toml"), "a = 1\n[t]\nb = \"x\"\n"), None);
        assert_eq!(check(Path::new("a.yaml"), "a: 1\nb:\n  - x\n"), None);
        assert_eq!(check(Path::new("a.yml"), "a: 1\n---\nb: 2\n"), None);
    }

    #[test]
    fn broken_json_names_file_line_and_column() {
        let w = check(Path::new("dir/a.json"), "{\n  \"a\": 1\n  \"b\": 2\n}").unwrap();
        assert!(w.starts_with("WARNING: a.json does not parse after this change: "), "{w}");
        assert!(w.contains("line 3 column"), "{w}");
        assert!(w.ends_with("Fix it before moving on."), "{w}");
        assert!(!w.contains('\n'));
    }

    #[test]
    fn broken_toml_has_line_and_column() {
        let w = check(Path::new("Cargo.toml"), "a = 1\nb = \n").unwrap();
        assert!(w.contains("Cargo.toml does not parse"), "{w}");
        assert!(w.contains("line 2 column"), "{w}");
        assert!(!w.contains('\n'));
    }

    #[test]
    fn broken_yaml_is_reported() {
        let w = check(Path::new("c.yaml"), "a: [1, 2\nb: 3\n").unwrap();
        assert!(w.contains("c.yaml does not parse"), "{w}");
        assert!(w.contains("line"), "{w}");
    }

    #[test]
    fn extension_match_is_case_insensitive() {
        assert!(check(Path::new("A.JSON"), "{").is_some());
        assert!(check(Path::new("a.Toml"), "a =").is_some());
        assert!(check(Path::new("a.YML"), "a: [").is_some());
        assert!(is_checked(Path::new("X.Yaml")));
    }

    #[test]
    fn unknown_or_missing_extension_says_nothing() {
        assert_eq!(check(Path::new("a.txt"), "{"), None);
        assert_eq!(check(Path::new("a.jsonc"), "{"), None);
        assert_eq!(check(Path::new("Makefile"), "{"), None);
        assert!(!is_checked(Path::new("a.jsonc")));
    }

    #[test]
    fn oversized_text_is_skipped() {
        let big = format!("{{\"a\": \"{}\"", "x".repeat(MAX_CHECK_BYTES));
        assert_eq!(check(Path::new("a.json"), &big), None);
    }

    #[test]
    fn long_messages_are_capped() {
        let flat = one_line(&"word ".repeat(200));
        assert!(flat.chars().count() <= MAX_MESSAGE_CHARS + 3);
        assert!(flat.ends_with("..."));
    }

    #[test]
    fn switch_off_says_nothing() {
        assert_eq!(check_if(false, Path::new("a.json"), "{"), None);
        assert!(check_if(true, Path::new("a.json"), "{").is_some());
    }
}
