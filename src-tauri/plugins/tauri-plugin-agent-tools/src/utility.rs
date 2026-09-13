//! Hidden internal utility agents: titling, summarising, classifying. AH-208.
//!
//! These are model calls Jan makes for itself. They are not agents a person
//! chose, so they do not appear as agents or on the tool timeline; but a model
//! call made with the user's conversation is exactly the kind of thing that
//! must be accountable, so every one is recorded here.
//!
//! The record holds what happened, never what was said: kind, session, model,
//! outcome, duration and token counts. No prompt, no transcript, no output.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UtilityKind {
    Title,
    Summary,
    Classify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UtilityOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtilityInvocation {
    #[serde(rename = "v")]
    pub version: u32,
    pub at: String,
    pub id: String,
    pub kind: UtilityKind,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub model: String,
    pub outcome: UtilityOutcome,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub prompt_tokens: Option<u64>,
    #[serde(default)]
    pub completion_tokens: Option<u64>,
    /// Always false: the call is made without tools, and the renderer's
    /// wrapper has no way to pass any. Recorded so an audit can show it.
    #[serde(default)]
    pub tools_offered: bool,
}

pub fn log_path(data_folder: &Path) -> PathBuf {
    data_folder.join("audit").join("utility-agents.jsonl")
}

/// The fields that may be persisted, checked rather than trusted: the record
/// arrives over IPC, and a free-text field is where content would leak in.
fn sanitized(record: &UtilityInvocation) -> UtilityInvocation {
    // Refused whole, never filtered: stripping the disallowed characters from
    // "model\nsummary: the plan" keeps "summarytheplan", which is still the
    // content. An identifier is either an identifier or it is not recorded.
    let clip = |s: &str, n: usize| -> String {
        let ok = s.len() <= n
            && s
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c));
        if ok {
            s.to_string()
        } else {
            "(invalid)".to_string()
        }
    };
    UtilityInvocation {
        version: SCHEMA_VERSION,
        at: crate::audit::now(),
        id: clip(&record.id, 80),
        kind: record.kind,
        session: clip(&record.session, 120),
        model: clip(&record.model, 120),
        outcome: record.outcome,
        duration_ms: record.duration_ms,
        prompt_tokens: record.prompt_tokens,
        completion_tokens: record.completion_tokens,
        tools_offered: false,
    }
}

/// Append one invocation. Never fails the call it describes.
pub fn append(data_folder: &Path, record: &UtilityInvocation) {
    let record = sanitized(record);
    let result = (|| -> Result<(), String> {
        let path = log_path(data_folder);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        eprintln!("utility agent audit: could not record {}: {e}", record.id);
    }
}

/// One session's utility invocations, oldest first. A session must be named.
pub fn for_session(data_folder: &Path, session: &str) -> Result<Vec<UtilityInvocation>, String> {
    if session.is_empty() {
        return Err("a utility-agent lookup must name a session".into());
    }
    let Ok(file) = std::fs::File::open(log_path(data_folder)) else {
        return Ok(Vec::new());
    };
    Ok(std::io::BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<UtilityInvocation>(&l).ok())
        .filter(|r| r.session == session)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jan-utility-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn record(session: &str) -> UtilityInvocation {
        UtilityInvocation {
            version: 1,
            at: String::new(),
            id: "util-1".into(),
            kind: UtilityKind::Title,
            session: session.into(),
            model: "pxa-27b".into(),
            outcome: UtilityOutcome::Succeeded,
            duration_ms: 120,
            prompt_tokens: Some(40),
            completion_tokens: Some(6),
            tools_offered: false,
        }
    }

    #[test]
    fn every_invocation_is_recorded_and_found_by_session() {
        let d = dir("record");
        append(&d, &record("s1"));
        append(&d, &UtilityInvocation { outcome: UtilityOutcome::Cancelled, ..record("s1") });
        append(&d, &record("s2"));
        let found = for_session(&d, "s1").unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[1].outcome, UtilityOutcome::Cancelled);
    }

    #[test]
    fn a_lookup_must_name_a_session() {
        assert!(for_session(&dir("unscoped"), "").is_err());
    }

    /// The record arrives over IPC. Content smuggled into a free-text field
    /// does not reach the file, and "tools offered" cannot be claimed true.
    #[test]
    fn free_text_is_stripped_and_tools_are_never_recorded_as_offered() {
        let d = dir("sanitize");
        append(
            &d,
            &UtilityInvocation {
                model: "pxa-27b\nsummary: the user's secret plan".into(),
                session: "s1 with spaces and \"quotes\"".into(),
                tools_offered: true,
                ..record("s1")
            },
        );
        let text = std::fs::read_to_string(log_path(&d)).unwrap();
        assert!(!text.contains("secret"), "{text}");
        assert!(!text.contains("quotes"), "{text}");
        assert!(text.contains("\"model\":\"(invalid)\""), "{text}");
        assert!(text.contains("\"toolsOffered\":false"), "{text}");
    }
}
