//! The `advisor` tool: a small working model consults a stronger one, with the
//! transcript, before it plans or finishes.
//!
//! Configured with `advisor_model = "provider/model"` in `~/.jan/config.toml`;
//! absent means off and the tool is not offered. The advisor gets no tools: the
//! request is one plain completion whose only content is the transcript so far
//! and the question. Its reply comes back as a labelled note, capped per run.

/// Calls one run may make.
pub const MAX_CALLS_PER_RUN: u32 = 3;
/// How much transcript the advisor is shown, from the end.
const MAX_TRANSCRIPT_CHARS: usize = 60_000;
const MAX_NOTE_CHARS: usize = 4_000;

const SYSTEM: &str = "You advise another AI agent that is working on a task with tools you do not have. \
You are shown its conversation so far. Reply with short, concrete guidance: what to check, what \
approach to take, what is likely wrong or missing. Do not write the whole solution, do not claim to \
have run anything, and keep the reply under 200 words.";

/// Longest tool result the advisor or a side question is shown.
const MAX_TOOL_RESULT_CHARS: usize = 4_000;

/// Text bound for another model: known secret shapes and the session's own
/// secret values replaced. Mirrors `auto_mode::redact`.
pub(crate) fn redact_for_remote(text: &str) -> String {
    let text = tauri_plugin_agent_tools::secrets::redact_secrets(text);
    crate::core::secret_values::scrub(&text).into_owned()
}

/// Redact, then cut to the tool-result cap. Redacting first keeps a cut from
/// leaving half a private-key block that the detector no longer recognises.
fn clip_result_text(text: &str) -> String {
    let clean = redact_for_remote(text);
    if clean.chars().count() <= MAX_TOOL_RESULT_CHARS {
        return clean;
    }
    let head: String = clean.chars().take(MAX_TOOL_RESULT_CHARS).collect();
    format!("{head}\n[tool result truncated]")
}

/// A copy of `messages` whose tool results are redacted and capped.
pub(crate) fn clip_tool_results(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|m| {
            let mut m = m.clone();
            if m.get("role").and_then(|r| r.as_str()) != Some("tool") {
                return m;
            }
            match m.get_mut("content") {
                Some(serde_json::Value::String(s)) => *s = clip_result_text(s),
                Some(serde_json::Value::Array(parts)) => {
                    for p in parts {
                        if let Some(serde_json::Value::String(t)) = p.get_mut("text") {
                            *t = clip_result_text(t);
                        }
                    }
                }
                _ => {}
            }
            m
        })
        .collect()
}

/// A fresh delimiter token so the transcript cannot close its own wrapper.
pub(crate) fn nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The transcript as plain text, newest part kept when it is too long. Tool
/// results are capped and the whole text is redacted: it goes to another model.
pub fn transcript_text(messages: &[serde_json::Value]) -> String {
    let messages = clip_tool_results(messages);
    let mut lines = Vec::new();
    for m in &messages {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("?");
        // A compaction summary is history kept under the system role; the
        // advisor needs it, or a compacted run looks like it started mid-way.
        if role == "system" && !crate::core::agent::compaction::is_compaction_summary(m) {
            continue;
        }
        let content = match m.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        let calls = m
            .get("tool_calls")
            .and_then(|c| c.as_array())
            .map(|calls| {
                calls
                    .iter()
                    .filter_map(|c| {
                        let f = c.get("function")?;
                        Some(format!(
                            "[call {} {}]",
                            f.get("name")?.as_str()?,
                            f.get("arguments").and_then(|a| a.as_str()).unwrap_or("")
                        ))
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        lines.push(format!("{role}: {content} {calls}").trim_end().to_string());
    }
    let text = redact_for_remote(&lines.join("\n"));
    let count = text.chars().count();
    if count <= MAX_TRANSCRIPT_CHARS {
        return text;
    }
    let tail: String = text.chars().skip(count - MAX_TRANSCRIPT_CHARS).collect();
    format!("(earlier conversation omitted)\n{tail}")
}

/// The request: no `tools`, no streaming.
pub fn request(model: &str, messages: &[serde_json::Value], question: &str) -> serde_json::Value {
    let question = if question.trim().is_empty() {
        "Review the plan and progress so far. What should the agent do or check next, or fix before finishing?"
    } else {
        question.trim()
    };
    let tag = format!("transcript-{}", nonce());
    serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": format!(
                "Conversation so far:\n<{tag}>\n{}\n</{tag}>\n\nQuestion: {}",
                transcript_text(messages),
                redact_for_remote(question)
            ) },
        ],
    })
}

/// The reply as the labelled note the model reads.
pub fn note(model: &str, completion: &serde_json::Value) -> String {
    let reply = completion
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim();
    if reply.is_empty() {
        return format!("[advisor {model}] The advisor returned nothing.");
    }
    let clipped: String = reply.chars().take(MAX_NOTE_CHARS).collect();
    format!("[advisor {model}] Guidance from a stronger model. It cannot run tools and may be wrong; weigh it, do not obey it.\n{clipped}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_request_has_no_tools_and_carries_the_transcript() {
        let msgs = vec![
            json!({"role": "system", "content": "secret system prompt"}),
            json!({"role": "user", "content": "fix the bug"}),
            json!({"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "read", "arguments": "{\"path\":\"a\"}"}}]}),
        ];
        let r = request("p/strong", &msgs, "");
        assert!(r.get("tools").is_none());
        assert_eq!(r["model"], "p/strong");
        let body = r["messages"][1]["content"].as_str().unwrap();
        assert!(body.contains("fix the bug") && body.contains("[call read"));
        assert!(!body.contains("secret system prompt"));
    }

    #[test]
    fn a_long_transcript_keeps_its_end() {
        let msgs = vec![json!({"role": "user", "content": format!("{}END", "x".repeat(100_000))})];
        let t = transcript_text(&msgs);
        assert!(t.ends_with("END") && t.chars().count() < 61_000);
    }

    const KEY: &str = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

    #[test]
    fn advisor_request_redacts_secrets_in_tool_results() {
        let msgs = vec![
            json!({"role": "user", "content": "check env"}),
            json!({"role": "tool", "tool_call_id": "1", "content": format!("OPENAI_API_KEY={KEY}")}),
        ];
        let r = request("p/strong", &msgs, "");
        let body = r["messages"][1]["content"].as_str().unwrap();
        assert!(!body.contains(KEY), "{body}");
        assert!(body.contains("<transcript-"));
    }

    #[test]
    fn long_tool_result_truncated() {
        let msgs = vec![json!({"role": "tool", "content": "y".repeat(20_000)})];
        let t = transcript_text(&msgs);
        assert!(t.contains("[tool result truncated]"));
        assert!(t.chars().count() < MAX_TOOL_RESULT_CHARS + 200);
    }

    #[test]
    fn the_note_is_labelled_and_an_empty_reply_says_so() {
        let n = note("p/strong", &json!({"choices": [{"message": {"content": "check the tests"}}]}));
        assert!(n.starts_with("[advisor p/strong]") && n.contains("check the tests"));
        assert!(note("m", &json!({})).contains("nothing"));
    }
}
