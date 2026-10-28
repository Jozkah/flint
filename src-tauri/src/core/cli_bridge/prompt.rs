//! Turns an OpenAI chat request into the single text prompt a vendor CLI takes,
//! and turns the CLI's text back into OpenAI content and tool calls.
//!
//! The CLIs are used only as a model: their own tools are switched off, so Flint
//! keeps running its own tools. Tool calling is therefore carried in text with a
//! small tagged protocol (`<tool_call>{json}</tool_call>`).

use serde_json::{json, Value};

const OPEN: &str = "<tool_call>";
const CLOSE: &str = "</tool_call>";

/// One tool call the model asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

/// A request reduced to what a CLI needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Prompt {
    pub system: String,
    pub transcript: String,
    pub has_tools: bool,
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part.get("type").and_then(Value::as_str) {
                Some("text") => part
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                Some("image_url") | Some("input_image") => "[image omitted]".to_string(),
                _ => String::new(),
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn tool_call_block(name: &str, arguments: &Value) -> String {
    format!("{OPEN}{}{CLOSE}", json!({"name": name, "arguments": arguments}))
}

fn tool_protocol(tools: &[Value]) -> String {
    let specs: Vec<Value> = tools
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function")?;
            Some(json!({
                "name": function.get("name")?,
                "description": function.get("description").cloned().unwrap_or(Value::Null),
                "parameters": function.get("parameters").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect();
    format!(
        "You can call tools. To call one, write {OPEN}{{\"name\":\"<tool name>\",\"arguments\":{{...}}}}{CLOSE} \
         with valid JSON arguments matching the tool's schema. You may write several calls in one reply. \
         Write nothing after your last call: the results arrive in the next message as \
         <tool_result> blocks. Never pretend a tool ran; call it. Reply in plain text when no tool is needed.\n\n\
         Available tools (JSON):\n{}",
        Value::Array(specs)
    )
}

/// Reduce an OpenAI `chat/completions` body to a CLI prompt.
pub fn build_prompt(body: &Value) -> Prompt {
    let mut system: Vec<String> = Vec::new();
    let mut transcript = String::new();
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // Tool results name the call by id only; recover the tool name from the
    // assistant turn that made the call.
    let mut call_names: std::collections::HashMap<String, String> = Default::default();
    for message in &messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        let text = message.get("content").map(content_text).unwrap_or_default();
        match role {
            "system" | "developer" => system.push(text),
            "assistant" => {
                let mut turn = text;
                for call in message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let function = call.get("function").cloned().unwrap_or(Value::Null);
                    let name = function
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        call_names.insert(id.to_string(), name.clone());
                    }
                    let arguments = function
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|raw| serde_json::from_str(raw).ok())
                        .unwrap_or_else(|| json!({}));
                    if !turn.is_empty() {
                        turn.push('\n');
                    }
                    turn.push_str(&tool_call_block(&name, &arguments));
                }
                transcript.push_str(&format!("[assistant]\n{turn}\n\n"));
            }
            "tool" => {
                let id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let name = call_names.get(id).map(String::as_str).unwrap_or("tool");
                transcript.push_str(&format!(
                    "<tool_result name=\"{name}\" id=\"{id}\">\n{text}\n</tool_result>\n\n"
                ));
            }
            _ => transcript.push_str(&format!("[user]\n{text}\n\n")),
        }
    }
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .filter(|tools| !tools.is_empty());
    if let Some(tools) = tools {
        system.push(tool_protocol(tools));
    }
    transcript.push_str("[assistant]\n");
    Prompt {
        system: system.join("\n\n"),
        transcript,
        has_tools: tools.is_some(),
    }
}

/// Splits streamed model text into plain content and tool-call blocks. Text is
/// released as soon as it cannot be the start of a `<tool_call>` tag; once a tag
/// opens, everything after it is held for [`ToolStream::finish`].
#[derive(Debug, Default)]
pub struct ToolStream {
    held: String,
    in_call: bool,
    started: bool,
}

impl ToolStream {
    /// Feed a chunk; returns text that is safe to emit now.
    pub fn push(&mut self, chunk: &str) -> String {
        self.held.push_str(chunk);
        if self.in_call {
            return String::new();
        }
        if !self.started {
            // Models sometimes echo the turn cue; drop it once, at the start.
            let trimmed = self.held.trim_start();
            if "[assistant]".starts_with(trimmed) && !trimmed.is_empty() {
                return String::new();
            }
            self.started = true;
            if let Some(rest) = trimmed.strip_prefix("[assistant]") {
                self.held = rest.trim_start_matches('\n').to_string();
            }
        }
        if let Some(at) = self.held.find(OPEN) {
            let text = self.held[..at].to_string();
            self.held = self.held[at..].to_string();
            self.in_call = true;
            return text;
        }
        // Keep back a tail that might still grow into the opening tag.
        let keep = (1..OPEN.len().min(self.held.len() + 1))
            .rev()
            .find(|n| self.held.is_char_boundary(self.held.len() - n) && OPEN.starts_with(&self.held[self.held.len() - n..]))
            .unwrap_or(0);
        let cut = self.held.len() - keep;
        let text = self.held[..cut].to_string();
        self.held = self.held[cut..].to_string();
        text
    }

    /// End of output: the last releasable text and every parsed tool call.
    pub fn finish(self) -> (String, Vec<ToolCall>) {
        if !self.in_call {
            return (self.held, Vec::new());
        }
        let mut calls = Vec::new();
        let mut rest = self.held.as_str();
        while let Some(start) = rest.find(OPEN) {
            let after = &rest[start + OPEN.len()..];
            let (body, next) = match after.find(CLOSE) {
                Some(end) => (&after[..end], &after[end + CLOSE.len()..]),
                None => (after, ""),
            };
            if let Some(call) = parse_call(body) {
                calls.push(call);
            }
            rest = next;
        }
        (String::new(), calls)
    }
}

fn parse_call(body: &str) -> Option<ToolCall> {
    let body = body.trim();
    // Tolerate a fenced block around the JSON.
    let body = body
        .strip_prefix("```json")
        .or_else(|| body.strip_prefix("```"))
        .map(|inner| inner.trim_end_matches("```").trim())
        .unwrap_or(body);
    let value: Value = serde_json::from_str(body).ok()?;
    let name = value.get("name")?.as_str()?.to_string();
    let arguments = value.get("arguments").cloned().unwrap_or_else(|| json!({}));
    Some(ToolCall { name, arguments })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&str]) -> (String, Vec<ToolCall>) {
        let mut stream = ToolStream::default();
        let mut text = String::new();
        for chunk in chunks {
            text.push_str(&stream.push(chunk));
        }
        let (rest, calls) = stream.finish();
        text.push_str(&rest);
        (text, calls)
    }

    #[test]
    fn plain_text_streams_through_unchanged() {
        assert_eq!(run(&["hel", "lo ", "there"]).0, "hello there");
    }

    #[test]
    fn a_call_split_across_chunks_is_parsed_and_leading_text_kept() {
        let (text, calls) = run(&[
            "Checking. <tool_",
            "call>{\"name\":\"bash\",\"argu",
            "ments\":{\"cmd\":\"ls\"}}</tool_call>",
        ]);
        assert_eq!(text, "Checking. ");
        assert_eq!(
            calls,
            vec![ToolCall { name: "bash".into(), arguments: json!({"cmd": "ls"}) }]
        );
    }

    #[test]
    fn a_lone_angle_bracket_is_not_swallowed() {
        assert_eq!(run(&["a < b and <t", "able>"]).0, "a < b and <table>");
    }

    #[test]
    fn several_calls_and_fenced_json_parse() {
        let (_, calls) = run(&[
            "<tool_call>```json\n{\"name\":\"a\",\"arguments\":{}}\n```</tool_call>\
             <tool_call>{\"name\":\"b\"}</tool_call>",
        ]);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].arguments, json!({}));
    }

    #[test]
    fn an_echoed_turn_cue_is_dropped() {
        assert_eq!(run(&["[assist", "ant]\nhi"]).0, "hi");
    }

    #[test]
    fn prompt_renders_tool_turns_and_keeps_the_tool_name() {
        let body = json!({
            "tools": [{"type": "function", "function": {"name": "bash", "description": "run", "parameters": {"type": "object"}}}],
            "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "list"},
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "bash", "arguments": "{\"cmd\":\"ls\"}"}}]},
                {"role": "tool", "tool_call_id": "c1", "content": "a.txt"}
            ]
        });
        let prompt = build_prompt(&body);
        assert!(prompt.has_tools);
        assert!(prompt.system.starts_with("be brief"));
        assert!(prompt.system.contains("\"name\":\"bash\""));
        let (_, calls) = {
            let mut stream = ToolStream::default();
            stream.push(&prompt.transcript);
            stream.finish()
        };
        assert_eq!(calls, vec![ToolCall { name: "bash".into(), arguments: json!({"cmd": "ls"}) }]);
        assert!(prompt.transcript.contains("<tool_result name=\"bash\" id=\"c1\">\na.txt\n</tool_result>"));
        assert!(prompt.transcript.ends_with("[assistant]\n"));
    }
}
