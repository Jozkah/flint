//! Full-text search across the text of every conversation.
//!
//! The search dialog used to match thread titles only. This scans each
//! thread's `messages.jsonl` for a phrase and returns where it was said, so
//! "the chat where I asked about the cache key" can be found by what was in it.
//! Only text the user can read is searched: the text parts of user and
//! assistant messages, not reasoning, tool input or output, or messages the
//! app marks hidden (a compaction summary).

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::constants::THREADS_FILE;
use super::utils::{get_data_dir, get_messages_path};

/// Characters of context kept on each side of a match in a snippet.
const SNIPPET_CONTEXT: usize = 48;
/// Matches reported from any one chat, so a long one cannot fill the list.
const PER_THREAD_CAP: usize = 3;
/// The most a single call returns.
pub const MAX_LIMIT: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageHit {
    pub thread_id: String,
    pub thread_title: String,
    pub message_id: String,
    pub role: String,
    pub snippet: String,
    /// Seconds since the epoch of the thread's last update, for ordering.
    pub updated: f64,
}

fn text_of(message: &Value) -> String {
    let mut out = String::new();
    match message.get("content") {
        Some(Value::Array(parts)) => {
            for part in parts {
                if part.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                let value = part
                    .pointer("/text/value")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("text").and_then(Value::as_str));
                if let Some(value) = value {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(value);
                }
            }
        }
        Some(Value::String(s)) => out.push_str(s),
        _ => {}
    }
    out
}

fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// A window of `text` around the match at char index `at`, on one line.
fn snippet(chars: &[char], at: usize, len: usize) -> String {
    let from = at.saturating_sub(SNIPPET_CONTEXT);
    let to = (at + len + SNIPPET_CONTEXT).min(chars.len());
    let body: String = chars[from..to]
        .iter()
        .map(|c| if c.is_whitespace() { ' ' } else { *c })
        .collect();
    format!(
        "{}{}{}",
        if from > 0 { "…" } else { "" },
        body.trim(),
        if to < chars.len() { "…" } else { "" }
    )
}

/// First match of `needle` (already folded) in `hay`, as a char index.
fn find_chars(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

/// Search every thread under `root`. Threads and lines that cannot be read are
/// skipped, never fatal: one damaged chat must not hide the rest.
pub fn search_messages_in(
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<MessageHit>, String> {
    let needle: Vec<char> = query.trim().chars().map(fold).collect();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, MAX_LIMIT);
    let data_dir = get_data_dir(root);
    if !data_dir.exists() {
        return Ok(Vec::new());
    }

    let mut threads: Vec<(String, String, f64)> = Vec::new();
    for entry in fs::read_dir(&data_dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let Ok(raw) = fs::read_to_string(path.join(THREADS_FILE)) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let title = meta
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let updated = meta.get("updated").and_then(Value::as_f64).unwrap_or(0.0);
        threads.push((id, title, updated));
    }
    // The most recently used chats first, so the cap keeps what is likely wanted.
    threads.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    let mut hits = Vec::new();
    'threads: for (id, title, updated) in threads {
        let Ok(file) = fs::File::open(get_messages_path(root, &id)) else {
            continue;
        };
        let mut in_thread = 0;
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            if message
                .pointer("/metadata/hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let text = text_of(&message);
            if text.is_empty() {
                continue;
            }
            let chars: Vec<char> = text.chars().collect();
            let folded: Vec<char> = chars.iter().copied().map(fold).collect();
            let Some(at) = find_chars(&folded, &needle) else {
                continue;
            };
            hits.push(MessageHit {
                thread_id: id.clone(),
                thread_title: title.clone(),
                message_id: message
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                role: role.to_string(),
                snippet: snippet(&chars, at, needle.len()),
                updated,
            });
            if hits.len() >= limit {
                break 'threads;
            }
            in_thread += 1;
            if in_thread >= PER_THREAD_CAP {
                break;
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::threads::helpers::write_messages_to_file;
    use serde_json::json;

    fn thread(root: &Path, id: &str, title: &str, updated: u64, messages: Vec<Value>) {
        let dir = root.join("threads").join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(THREADS_FILE),
            json!({"id": id, "title": title, "updated": updated}).to_string(),
        )
        .unwrap();
        write_messages_to_file(&messages, &get_messages_path(root, id)).unwrap();
    }

    fn msg(id: &str, role: &str, text: &str) -> Value {
        json!({"id": id, "role": role, "content": [{"type": "text", "text": {"value": text}}]})
    }

    #[test]
    fn finds_text_case_insensitively_with_a_snippet_and_ids() {
        let tmp = tempfile::tempdir().unwrap();
        thread(
            tmp.path(),
            "t1",
            "Cache bug",
            10,
            vec![
                msg("m1", "user", "Why is the cache stale?"),
                msg("m2", "assistant", "Because the KEY ignores the locale."),
            ],
        );
        let hits = search_messages_in(tmp.path(), "key ignores", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].thread_id, "t1");
        assert_eq!(hits[0].thread_title, "Cache bug");
        assert_eq!(hits[0].message_id, "m2");
        assert_eq!(hits[0].role, "assistant");
        assert!(hits[0].snippet.contains("KEY ignores"));
    }

    #[test]
    fn skips_reasoning_tool_parts_and_hidden_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let reasoning = json!({"id": "r", "role": "assistant",
            "content": [{"type": "reasoning", "text": {"value": "needle in thought"}}]});
        let tool = json!({"id": "tc", "role": "assistant",
            "content": [{"type": "tool_call", "tool_name": "bash", "output": "needle"}]});
        let hidden = json!({"id": "h", "role": "user", "metadata": {"hidden": true},
            "content": [{"type": "text", "text": {"value": "needle summary"}}]});
        thread(tmp.path(), "t1", "T", 1, vec![reasoning, tool, hidden]);
        assert!(search_messages_in(tmp.path(), "needle", 20)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn orders_recent_threads_first_and_caps_each_thread_and_the_total() {
        let tmp = tempfile::tempdir().unwrap();
        let many: Vec<Value> = (0..6)
            .map(|i| msg(&format!("o{i}"), "user", "needle old"))
            .collect();
        thread(tmp.path(), "old", "Old", 1, many);
        thread(
            tmp.path(),
            "new",
            "New",
            99,
            vec![msg("n1", "user", "a needle here")],
        );

        let hits = search_messages_in(tmp.path(), "needle", 20).unwrap();
        assert_eq!(hits[0].thread_id, "new");
        // Three from the old chat at most.
        assert_eq!(
            hits.iter().filter(|h| h.thread_id == "old").count(),
            PER_THREAD_CAP
        );

        let capped = search_messages_in(tmp.path(), "needle", 2).unwrap();
        assert_eq!(capped.len(), 2);
    }

    #[test]
    fn a_damaged_chat_does_not_hide_the_others_and_blank_queries_find_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        thread(
            tmp.path(),
            "ok",
            "Ok",
            5,
            vec![msg("m", "user", "findme please")],
        );
        let bad = tmp.path().join("threads").join("bad");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join(THREADS_FILE), "{not json").unwrap();
        let torn = tmp.path().join("threads").join("torn");
        fs::create_dir_all(&torn).unwrap();
        fs::write(
            torn.join(THREADS_FILE),
            json!({"id": "torn", "title": "Torn"}).to_string(),
        )
        .unwrap();
        fs::write(
            torn.join("messages.jsonl"),
            "{\"id\":\"a\",\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":{\"value\":\"findme torn\"}}]}\n{\"id\":\"b\",\"ro",
        )
        .unwrap();

        let hits = search_messages_in(tmp.path(), "findme", 20).unwrap();
        let ids: Vec<_> = hits.iter().map(|h| h.thread_id.as_str()).collect();
        assert!(ids.contains(&"ok") && ids.contains(&"torn"));
        assert!(search_messages_in(tmp.path(), "   ", 20)
            .unwrap()
            .is_empty());
        assert!(search_messages_in(&tmp.path().join("nowhere"), "x", 20)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn matches_non_ascii_text_without_shifting_the_snippet() {
        let tmp = tempfile::tempdir().unwrap();
        thread(
            tmp.path(),
            "t",
            "T",
            1,
            vec![msg("m", "user", "Größe ÄÖÜ naïve café résumé")],
        );
        let hits = search_messages_in(tmp.path(), "NAÏVE", 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("naïve"));
    }
}
