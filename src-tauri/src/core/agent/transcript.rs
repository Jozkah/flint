//! Finding something in a past run, and taking a transcript out (AH-178).
//!
//! Runs leave transcripts in two places: a project's own
//! `<project>/.jan/agent/threads/<id>/messages.jsonl`, and the desktop's
//! `<data folder>/threads/<id>/messages.jsonl`. The desktop app can search
//! what it holds; nothing could search the project's, and nothing could take a
//! transcript out at all -- so "what did that run do, three days ago" meant
//! opening files by hand.
//!
//! Two things this deliberately does not do:
//!
//! * **It does not index.** Search reads the transcripts, bounded, every time.
//!   An index is a second copy of everything said, with its own staleness and
//!   its own place to leak from, and a few hundred conversations are read
//!   faster than an index is explained.
//! * **It does not widen what is readable.** It reads exactly the transcripts
//!   the caller already has on disk, and it prints matches through the same
//!   scrubber the error path uses, so a credential a model once echoed into a
//!   transcript is not re-printed by the search for it.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The most transcripts read in one search, and the most lines read from each.
///
/// A search that reads without a bound is a search that hangs on a data folder
/// somebody has been using for a year. The bound is reported when it bites, so
/// an answer is never quietly partial.
pub const MAX_TRANSCRIPTS: usize = 2_000;
pub const MAX_MESSAGES: usize = 20_000;
/// How much of a matching message is shown, in characters, around the match.
pub const SNIPPET: usize = 160;

/// Where a transcript lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    /// `<project>/.jan/agent/threads`.
    Project,
    /// `<data folder>/threads`, which the desktop writes.
    Data,
}

/// One matching message.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub session: String,
    pub scope: Scope,
    /// Which message in the transcript, counting from 1.
    pub index: usize,
    pub role: String,
    /// The matching text, bounded and scrubbed.
    pub snippet: String,
    pub path: PathBuf,
}

/// What a search found, and what it could not read.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub hits: Vec<Hit>,
    /// Transcripts whose lines ran past the bound, or which could not be read.
    pub truncated: Vec<String>,
    /// How many transcripts were looked at.
    pub searched: usize,
}

/// How to search.
#[derive(Debug, Clone, Default)]
pub struct Query {
    /// The text to look for. Case-insensitive substring unless `regex`.
    pub text: String,
    /// Treat `text` as a regular expression.
    pub regex: bool,
    /// Only this session.
    pub session: Option<String>,
    /// Only messages in this role (`user`, `assistant`, `tool`).
    pub role: Option<String>,
    /// Stop after this many hits. 0 means every hit.
    pub limit: usize,
}

fn threads_dirs(project_root: Option<&Path>, data_folder: Option<&Path>) -> Vec<(Scope, PathBuf)> {
    let mut out = Vec::new();
    if let Some(root) = project_root {
        out.push((
            Scope::Project,
            root.join(".jan").join("agent").join("threads"),
        ));
    }
    if let Some(data) = data_folder {
        out.push((Scope::Data, data.join("threads")));
    }
    out
}

/// The text of a message, whatever shape it was written in: a plain string, or
/// the desktop's content-part array.
fn text_of(message: &serde_json::Value) -> String {
    match message.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(|t| t.get("value"))
                    .and_then(|v| v.as_str())
                    .or_else(|| part.get("text").and_then(|t| t.as_str()))
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// `SNIPPET` characters around the match, on character boundaries, with the
/// scrubber applied -- a transcript can hold a credential a model echoed, and
/// re-printing it because somebody searched for something else would be this
/// feature leaking it.
fn snippet_at(text: &str, at: usize) -> String {
    let start = text
        .char_indices()
        .map(|(i, _)| i).rfind(|i| *i <= at.saturating_sub(SNIPPET / 2))
        .unwrap_or(0);
    let end = text
        .char_indices()
        .map(|(i, _)| i)
        .find(|i| *i >= at + SNIPPET / 2)
        .unwrap_or(text.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(text[start..end].trim());
    if end < text.len() {
        out.push('…');
    }
    tauri_plugin_agent_tools::harness_error::scrub(&out)
}

/// Search the transcripts on disk (AH-178).
pub fn search(
    project_root: Option<&Path>,
    data_folder: Option<&Path>,
    query: &Query,
) -> Result<Found, tauri_plugin_agent_tools::harness_error::HarnessError> {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
    if query.text.trim().is_empty() {
        return Err(HarnessError::new(
            ErrorKind::InvalidInput,
            "a search needs something to look for",
        )
        .at(Stage::Startup));
    }
    let pattern = if query.regex {
        Some(
            regex::RegexBuilder::new(&query.text)
                .case_insensitive(true)
                .size_limit(1 << 20)
                .build()
                .map_err(|e| {
                    HarnessError::new(
                        ErrorKind::InvalidInput,
                        format!("that is not a regular expression this can read: {e}"),
                    )
                    .at(Stage::Startup)
                })?,
        )
    } else {
        None
    };
    let needle = query.text.to_lowercase();
    let mut found = Found::default();
    for (scope, dir) in threads_dirs(project_root, data_folder) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut sessions: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        // Newest first: the run somebody is looking for is usually a recent
        // one, and a bounded search should spend its budget there.
        sessions.sort_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
        });
        sessions.reverse();
        for session_dir in sessions.into_iter().take(MAX_TRANSCRIPTS) {
            let session = session_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            if query
                .session
                .as_deref()
                .is_some_and(|wanted| wanted != session)
            {
                continue;
            }
            let path = session_dir.join("messages.jsonl");
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            found.searched += 1;
            for (i, line) in text.lines().enumerate() {
                if i + 1 > MAX_MESSAGES {
                    found.truncated.push(session.clone());
                    break;
                }
                let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                let role = message
                    .get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if query.role.as_deref().is_some_and(|wanted| wanted != role) {
                    continue;
                }
                let body = text_of(&message);
                let at = match &pattern {
                    Some(re) => re.find(&body).map(|m| m.start()),
                    None => body.to_lowercase().find(&needle),
                };
                let Some(at) = at else { continue };
                found.hits.push(Hit {
                    session: session.clone(),
                    scope,
                    index: i + 1,
                    role,
                    snippet: snippet_at(&body, at),
                    path: path.clone(),
                });
                if query.limit > 0 && found.hits.len() >= query.limit {
                    return Ok(found);
                }
            }
        }
    }
    Ok(found)
}

/// How a transcript is written out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Text,
    Markdown,
    Json,
}

/// One session's transcript, as text, markdown or the lines themselves
/// (AH-178).
///
/// The export is what is on disk, not a summary of it: a tool call and its
/// result are part of what the run did, and an export that dropped them would
/// read as a model that described work instead of doing it.
pub fn export(
    project_root: Option<&Path>,
    data_folder: Option<&Path>,
    session: &str,
    format: Format,
) -> Result<String, tauri_plugin_agent_tools::harness_error::HarnessError> {
    use tauri_plugin_agent_tools::harness_error::{ErrorKind, HarnessError, Stage};
    let mut path = None;
    for (_, dir) in threads_dirs(project_root, data_folder) {
        let candidate = dir.join(session).join("messages.jsonl");
        if candidate.is_file() {
            path = Some(candidate);
            break;
        }
    }
    let Some(path) = path else {
        return Err(HarnessError::new(
            ErrorKind::NotFound,
            format!("no transcript for session {session:?} in this project or data folder"),
        )
        .at(Stage::Startup));
    };
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        HarnessError::new(ErrorKind::Io, format!("{}: {e}", path.display())).at(Stage::Startup)
    })?;
    if format == Format::Json {
        return Ok(raw);
    }
    let mut out = String::new();
    if format == Format::Markdown {
        out.push_str(&format!("# Transcript {session}\n\n"));
    }
    for line in raw.lines() {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("(no role)");
        let body = text_of(&message);
        let calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|calls| {
                calls
                    .iter()
                    .filter_map(|c| c.get("function").and_then(|f| f.get("name")))
                    .filter_map(|n| n.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty());
        match format {
            Format::Markdown => {
                out.push_str(&format!("## {role}\n\n"));
                if let Some(calls) = calls {
                    out.push_str(&format!("_called: {calls}_\n\n"));
                }
                if !body.trim().is_empty() {
                    out.push_str(body.trim());
                    out.push_str("\n\n");
                }
            }
            _ => {
                out.push_str(&format!("[{role}]"));
                if let Some(calls) = calls {
                    out.push_str(&format!(" (called: {calls})"));
                }
                out.push('\n');
                if !body.trim().is_empty() {
                    out.push_str(body.trim());
                    out.push('\n');
                }
                out.push('\n');
            }
        }
    }
    Ok(out)
}

/// The hits, as a person reads them.
pub fn render(found: &Found) -> String {
    if found.hits.is_empty() {
        return format!(
            "nothing matched in {} transcript(s)\n",
            found.searched
        );
    }
    let mut out = format!(
        "{} match(es) in {} transcript(s)\n",
        found.hits.len(),
        found.searched
    );
    for hit in &found.hits {
        out.push_str(&format!(
            "  {} #{} [{}] {}\n",
            hit.session, hit.index, hit.role, hit.snippet
        ));
    }
    for session in &found.truncated {
        out.push_str(&format!(
            "  (transcript {session} is longer than {MAX_MESSAGES} messages; the rest was not read)\n"
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jan_transcript_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::UNIX_EPOCH
                .elapsed()
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn write_transcript(threads: &Path, session: &str, lines: &[serde_json::Value]) {
        let dir = threads.join(session);
        std::fs::create_dir_all(&dir).expect("session dir");
        let text = lines
            .iter()
            .map(|m| serde_json::to_string(m).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.join("messages.jsonl"), format!("{text}\n")).expect("transcript");
    }

    fn project_with(session: &str, lines: &[serde_json::Value]) -> PathBuf {
        let root = temp_root("project");
        write_transcript(&root.join(".jan").join("agent").join("threads"), session, lines);
        root
    }

    /// A past run is found by what was said in it, in the project's own
    /// transcripts and in the data folder's alike.
    #[test]
    fn a_past_run_is_found_by_what_was_said_in_it() {
        let root = project_with(
            "s1",
            &[
                serde_json::json!({ "role": "user", "content": "please fix the plum-coloured banner" }),
                serde_json::json!({ "role": "assistant", "content": "I changed the banner colour." }),
            ],
        );
        let data = temp_root("data");
        write_transcript(
            &data.join("threads"),
            "s2",
            &[serde_json::json!({ "role": "user", "content": "something else entirely" })],
        );

        let found = search(
            Some(&root),
            Some(&data),
            &Query {
                text: "plum".to_string(),
                ..Default::default()
            },
        )
        .expect("searched");
        assert_eq!(found.hits.len(), 1, "{found:#?}");
        assert_eq!(found.hits[0].session, "s1");
        assert_eq!(found.hits[0].scope, Scope::Project);
        assert_eq!(found.hits[0].index, 1);
        assert!(found.hits[0].snippet.contains("plum-coloured"), "{:?}", found.hits[0]);
        assert_eq!(found.searched, 2, "both stores were searched");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&data);
    }

    /// The search is narrowed the way a person narrows it: one session, one
    /// role, a bounded number of answers.
    #[test]
    fn a_search_can_be_narrowed_by_session_role_and_count() {
        let root = temp_root("narrow");
        let threads = root.join(".jan").join("agent").join("threads");
        for session in ["a", "b"] {
            write_transcript(
                &threads,
                session,
                &[
                    serde_json::json!({ "role": "user", "content": "deploy the service" }),
                    serde_json::json!({ "role": "assistant", "content": "deploy done" }),
                ],
            );
        }
        let all = search(
            Some(&root),
            None,
            &Query { text: "deploy".into(), ..Default::default() },
        )
        .expect("searched");
        assert_eq!(all.hits.len(), 4);

        let one_session = search(
            Some(&root),
            None,
            &Query { text: "deploy".into(), session: Some("a".into()), ..Default::default() },
        )
        .expect("searched");
        assert_eq!(one_session.hits.len(), 2);
        assert!(one_session.hits.iter().all(|h| h.session == "a"));

        let one_role = search(
            Some(&root),
            None,
            &Query { text: "deploy".into(), role: Some("user".into()), ..Default::default() },
        )
        .expect("searched");
        assert_eq!(one_role.hits.len(), 2);
        assert!(one_role.hits.iter().all(|h| h.role == "user"));

        let capped = search(
            Some(&root),
            None,
            &Query { text: "deploy".into(), limit: 1, ..Default::default() },
        )
        .expect("searched");
        assert_eq!(capped.hits.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A regular expression is available, and one that cannot be read is
    /// refused rather than silently searched for literally.
    #[test]
    fn a_regular_expression_is_available_and_a_broken_one_is_refused() {
        use tauri_plugin_agent_tools::harness_error::ErrorKind;
        let root = project_with(
            "s1",
            &[serde_json::json!({ "role": "assistant", "content": "wrote config-v2.toml" })],
        );
        let found = search(
            Some(&root),
            None,
            &Query { text: r"config-v\d".into(), regex: true, ..Default::default() },
        )
        .expect("searched");
        assert_eq!(found.hits.len(), 1, "{found:#?}");

        let err = search(
            Some(&root),
            None,
            &Query { text: "config-v(".into(), regex: true, ..Default::default() },
        )
        .unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidInput);

        let empty = search(Some(&root), None, &Query::default()).unwrap_err();
        assert_eq!(empty.kind(), ErrorKind::InvalidInput);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A credential a model once echoed into a transcript is not re-printed by
    /// the search that happened to match the line it is on.
    #[test]
    fn a_secret_in_a_transcript_is_not_reprinted_by_the_search() {
        let root = project_with(
            "s1",
            &[serde_json::json!({
                "role": "assistant",
                "content": "exported the key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL for the job"
            })],
        );
        let found = search(
            Some(&root),
            None,
            &Query { text: "exported".into(), ..Default::default() },
        )
        .expect("searched");
        assert_eq!(found.hits.len(), 1);
        assert!(
            !found.hits[0].snippet.contains("AAAABBBB"),
            "the secret was printed back: {:?}",
            found.hits[0].snippet
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A transcript comes out whole -- what was said and what was called --
    /// in each shape, and an unknown session is refused by name.
    #[test]
    fn a_transcript_comes_out_whole_or_is_refused_by_name() {
        use tauri_plugin_agent_tools::harness_error::ErrorKind;
        let root = project_with(
            "s1",
            &[
                serde_json::json!({ "role": "user", "content": "read the file" }),
                serde_json::json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{ "id": "c1", "type": "function",
                                     "function": { "name": "read", "arguments": "{}" } }]
                }),
                serde_json::json!({ "role": "tool", "tool_call_id": "c1", "content": "file contents" }),
            ],
        );
        let text = export(Some(&root), None, "s1", Format::Text).expect("exported");
        assert!(text.contains("[user]"), "{text}");
        assert!(text.contains("called: read"), "{text}");
        assert!(text.contains("file contents"), "{text}");

        let markdown = export(Some(&root), None, "s1", Format::Markdown).expect("exported");
        assert!(markdown.starts_with("# Transcript s1"), "{markdown}");
        assert!(markdown.contains("## assistant"), "{markdown}");

        let json = export(Some(&root), None, "s1", Format::Json).expect("exported");
        assert_eq!(json.lines().count(), 3, "the lines themselves: {json}");

        let err = export(Some(&root), None, "nope", Format::Text).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::NotFound);
        assert!(err.message().contains("\"nope\""), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
