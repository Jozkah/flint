//! Translating-gateway support for the proxy.
//!
//! Jan's proxy accepts OpenAI chat/completions and, for OpenAI-compatible
//! upstreams, forwards verbatim. To also front providers with a different
//! native wire API (OpenAI `/v1/responses`, Google `generateContent`,
//! Anthropic `/v1/messages`), each such provider gets a converter that rewrites
//! the request and translates the response back to chat/completions.
//!
//! This module currently provides the shared primitive every converter needs:
//! an [`SseAccumulator`] that reassembles complete Server-Sent Events across
//! network chunk boundaries. The existing inline proxy parser splits each chunk
//! on lines and drops partial lines, which only survives because upstreams tend
//! to flush whole events; a real translator cannot rely on that.

/// One parsed Server-Sent Event.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SseEvent {
    /// The `event:` field value, empty when absent (chat/completions omits it;
    /// OpenAI `/responses` and Anthropic set it).
    pub event: String,
    /// Concatenated `data:` payload (multiple `data:` lines joined by `\n`),
    /// with sentinels like `[DONE]` preserved verbatim.
    pub data: String,
}

/// Accumulates raw response text and yields complete SSE events, buffering any
/// partial trailing event until its terminating blank line arrives in a later
/// chunk.
#[derive(Debug, Default)]
pub struct SseAccumulator {
    buf: String,
}

impl SseAccumulator {
    pub fn new() -> Self {
        Self { buf: String::new() }
    }

    /// Feed a chunk of the response body; returns every event completed by it.
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        // Normalize CRLF so boundary detection only has to look for "\n\n".
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let mut events = Vec::new();
        while let Some(idx) = self.buf.find("\n\n") {
            let raw: String = self.buf.drain(..idx + 2).collect();
            if let Some(ev) = parse_event(&raw) {
                events.push(ev);
            }
        }
        events
    }

    /// Flush a final event that arrived without a terminating blank line (some
    /// servers omit it before closing the connection).
    pub fn finish(&mut self) -> Option<SseEvent> {
        let raw = std::mem::take(&mut self.buf);
        parse_event(&raw)
    }
}

fn parse_event(raw: &str) -> Option<SseEvent> {
    let mut ev = SseEvent::default();
    let mut data_lines: Vec<&str> = Vec::new();
    let mut has_field = false;
    for line in raw.lines() {
        // Blank lines separate events; lines starting with ':' are comments.
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
            has_field = true;
        } else if let Some(rest) = line.strip_prefix("event:") {
            ev.event = rest.strip_prefix(' ').unwrap_or(rest).to_string();
            has_field = true;
        }
        // `id:`, `retry:`, and unknown fields are irrelevant to translation.
    }
    if !has_field {
        return None;
    }
    ev.data = data_lines.join("\n");
    Some(ev)
}

use serde_json::{json, Value};
use std::collections::HashMap;

/// Translates an OpenAI chat/completions request to a provider's native wire
/// API and its response back. Implementors front a provider whose native API is
/// not chat/completions (OpenAI `/v1/responses`, Google `generateContent`,
/// Anthropic `/v1/messages`); the proxy selects one by `ProviderConfig.api_type`
/// and otherwise forwards verbatim.
pub trait UpstreamConverter: Send + Sync {
    /// Path suffix appended to the provider `base_url` (e.g. `/responses`).
    fn upstream_path(&self) -> &'static str;

    /// Rewrite the inbound chat/completions body into the native request body.
    fn convert_request(&self, body: &Value) -> Value;

    /// Translate a non-streaming native response into a chat.completion object.
    fn convert_response(&self, upstream: &Value) -> Value;

    /// Translate one native SSE event into zero or more chat/completions SSE
    /// `data:` payloads (each a JSON chunk string, or the literal `[DONE]`).
    fn convert_stream_event(&self, event: &SseEvent, state: &mut StreamState) -> Vec<String>;
}

/// Select the converter for a provider's `api_type`. `None`, `"openai"`, and
/// unknown values keep the verbatim chat/completions passthrough.
pub fn converter_for(api_type: Option<&str>) -> Option<Box<dyn UpstreamConverter>> {
    match api_type {
        Some("openai-responses") => Some(Box::new(OpenAIResponsesConverter::new())),
        _ => None,
    }
}

/// Per-stream translation state threaded across `convert_stream_event` calls.
#[derive(Debug, Default)]
pub struct StreamState {
    pub id: String,
    pub model: String,
    pub created: i64,
    pub role_sent: bool,
    pub saw_tool_call: bool,
    /// native item/call id -> chat tool_calls array index.
    pub tool_index: HashMap<String, usize>,
    pub next_tool_index: usize,
    pub finished: bool,
}

/// Fronts OpenAI's `/v1/responses` API, exposing it as chat/completions so the
/// proxy's OpenAI-SDK clients get reasoning summaries (`reasoning_content`)
/// without switching wire formats.
#[derive(Debug, Default, Clone, Copy)]
pub struct OpenAIResponsesConverter;

impl OpenAIResponsesConverter {
    pub fn new() -> Self {
        Self
    }
}

/// Extract plain text from a chat message `content` (string or content-part array).
fn message_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

impl UpstreamConverter for OpenAIResponsesConverter {
    fn upstream_path(&self) -> &'static str {
        "/responses"
    }

    fn convert_request(&self, body: &Value) -> Value {
        let mut out = json!({});
        if let Some(model) = body.get("model") {
            out["model"] = model.clone();
        }

        // Split system/developer messages into `instructions`; the rest become
        // `input` items (Responses accepts chat-shaped {role, content}).
        let mut instructions: Vec<String> = Vec::new();
        let mut input_items: Vec<Value> = Vec::new();
        if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
            for msg in messages {
                let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                let content = msg.get("content").cloned().unwrap_or(Value::Null);
                match role {
                    "system" | "developer" => instructions.push(message_text(&content)),
                    "tool" => {
                        // Chat tool result -> Responses function_call_output item.
                        input_items.push(json!({
                            "type": "function_call_output",
                            "call_id": msg.get("tool_call_id").cloned().unwrap_or(Value::Null),
                            "output": message_text(&content),
                        }));
                    }
                    "assistant" if msg.get("tool_calls").is_some() => {
                        if let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) {
                            for call in calls {
                                let func = call.get("function");
                                input_items.push(json!({
                                    "type": "function_call",
                                    "call_id": call.get("id").cloned().unwrap_or(Value::Null),
                                    "name": func.and_then(|f| f.get("name")).cloned().unwrap_or(Value::Null),
                                    "arguments": func.and_then(|f| f.get("arguments")).cloned().unwrap_or(Value::String(String::new())),
                                }));
                            }
                        }
                        let text = message_text(&content);
                        if !text.is_empty() {
                            input_items.push(json!({"role": "assistant", "content": text}));
                        }
                    }
                    _ => input_items.push(json!({"role": role, "content": message_text(&content)})),
                }
            }
        }
        if !instructions.is_empty() {
            out["instructions"] = json!(instructions.join("\n\n"));
        }
        out["input"] = json!(input_items);

        for (src, dst) in [
            ("max_tokens", "max_output_tokens"),
            ("max_completion_tokens", "max_output_tokens"),
        ] {
            if let Some(v) = body.get(src) {
                out[dst] = v.clone();
            }
        }
        for key in ["temperature", "top_p", "stream"] {
            if let Some(v) = body.get(key) {
                out[key] = v.clone();
            }
        }

        if let Some(effort) = body.get("reasoning_effort").and_then(|e| e.as_str()) {
            out["reasoning"] = json!({"effort": effort, "summary": "auto"});
        }

        if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
            let flattened: Vec<Value> = tools
                .iter()
                .filter_map(|t| {
                    let func = t.get("function")?;
                    Some(json!({
                        "type": "function",
                        "name": func.get("name").cloned().unwrap_or(Value::Null),
                        "description": func.get("description").cloned().unwrap_or(Value::Null),
                        "parameters": func.get("parameters").cloned().unwrap_or(json!({})),
                    }))
                })
                .collect();
            out["tools"] = json!(flattened);
        }
        if let Some(tc) = body.get("tool_choice") {
            out["tool_choice"] = tc.clone();
        }

        out
    }

    fn convert_response(&self, upstream: &Value) -> Value {
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();

        if let Some(output) = upstream.get("output").and_then(|o| o.as_array()) {
            for item in output {
                match item.get("type").and_then(|t| t.as_str()) {
                    Some("message") => {
                        if let Some(parts) = item.get("content").and_then(|c| c.as_array()) {
                            for part in parts {
                                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                                    content.push_str(t);
                                }
                            }
                        }
                    }
                    Some("reasoning") => {
                        if let Some(parts) = item.get("summary").and_then(|s| s.as_array()) {
                            for part in parts {
                                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                                    reasoning.push_str(t);
                                }
                            }
                        }
                    }
                    Some("function_call") => {
                        tool_calls.push(json!({
                            "id": item.get("call_id").cloned().unwrap_or(Value::Null),
                            "type": "function",
                            "function": {
                                "name": item.get("name").cloned().unwrap_or(Value::Null),
                                "arguments": item.get("arguments").cloned().unwrap_or(Value::String(String::new())),
                            }
                        }));
                    }
                    _ => {}
                }
            }
        }

        let mut message = json!({"role": "assistant"});
        message["content"] = if content.is_empty() && !tool_calls.is_empty() {
            Value::Null
        } else {
            json!(content)
        };
        if !reasoning.is_empty() {
            message["reasoning_content"] = json!(reasoning);
        }
        let finish_reason = if !tool_calls.is_empty() {
            message["tool_calls"] = json!(tool_calls);
            "tool_calls"
        } else {
            "stop"
        };

        json!({
            "id": upstream.get("id").cloned().unwrap_or_else(|| json!("chatcmpl-proxy")),
            "object": "chat.completion",
            "created": upstream.get("created_at").cloned().unwrap_or_else(|| json!(0)),
            "model": upstream.get("model").cloned().unwrap_or(Value::Null),
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }],
            "usage": convert_usage(upstream.get("usage")),
        })
    }

    fn convert_stream_event(&self, event: &SseEvent, state: &mut StreamState) -> Vec<String> {
        if event.data == "[DONE]" || state.finished {
            return Vec::new();
        }
        let data: Value = match serde_json::from_str(&event.data) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let kind = if event.event.is_empty() {
            data.get("type").and_then(|t| t.as_str()).unwrap_or("")
        } else {
            event.event.as_str()
        };

        let mut out: Vec<String> = Vec::new();
        match kind {
            "response.created" | "response.in_progress" => {
                if let Some(resp) = data.get("response") {
                    if let Some(id) = resp.get("id").and_then(|v| v.as_str()) {
                        state.id = id.to_string();
                    }
                    if let Some(model) = resp.get("model").and_then(|v| v.as_str()) {
                        state.model = model.to_string();
                    }
                    if let Some(created) = resp.get("created_at").and_then(|v| v.as_i64()) {
                        state.created = created;
                    }
                }
            }
            "response.output_text.delta" => {
                if let Some(text) = data.get("delta").and_then(|d| d.as_str()) {
                    push_role_chunk(state, &mut out);
                    out.push(chunk_str(state, json!({"content": text}), None));
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(text) = data.get("delta").and_then(|d| d.as_str()) {
                    push_role_chunk(state, &mut out);
                    out.push(chunk_str(state, json!({"reasoning_content": text}), None));
                }
            }
            "response.output_item.added" => {
                if let Some(item) = data.get("item") {
                    if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                        let key = item
                            .get("id")
                            .and_then(|v| v.as_str())
                            .or_else(|| item.get("call_id").and_then(|v| v.as_str()))
                            .unwrap_or("")
                            .to_string();
                        let idx = state.next_tool_index;
                        state.next_tool_index += 1;
                        state.tool_index.insert(key, idx);
                        state.saw_tool_call = true;
                        push_role_chunk(state, &mut out);
                        out.push(chunk_str(
                            state,
                            json!({"tool_calls": [{
                                "index": idx,
                                "id": item.get("call_id").cloned().unwrap_or(Value::Null),
                                "type": "function",
                                "function": {
                                    "name": item.get("name").cloned().unwrap_or(Value::Null),
                                    "arguments": "",
                                }
                            }]}),
                            None,
                        ));
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                let key = data
                    .get("item_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(delta) = data.get("delta").and_then(|d| d.as_str()) {
                    let idx = *state.tool_index.get(&key).unwrap_or(&0);
                    out.push(chunk_str(
                        state,
                        json!({"tool_calls": [{
                            "index": idx,
                            "function": {"arguments": delta}
                        }]}),
                        None,
                    ));
                }
            }
            "response.completed" | "response.incomplete" => {
                let finish = if state.saw_tool_call { "tool_calls" } else { "stop" };
                out.push(chunk_str_with_usage(
                    state,
                    json!({}),
                    Some(finish),
                    data.get("response").and_then(|r| r.get("usage")),
                ));
                out.push("[DONE]".to_string());
                state.finished = true;
            }
            "response.failed" | "error" => {
                let message = data
                    .get("response")
                    .and_then(|r| r.get("error"))
                    .or_else(|| data.get("error"))
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("upstream error");
                out.push(json!({"error": {"message": message}}).to_string());
                out.push("[DONE]".to_string());
                state.finished = true;
            }
            _ => {}
        }
        out
    }
}

fn push_role_chunk(state: &mut StreamState, out: &mut Vec<String>) {
    if !state.role_sent {
        state.role_sent = true;
        out.push(chunk_str(state, json!({"role": "assistant"}), None));
    }
}

fn chunk_str(state: &StreamState, delta: Value, finish: Option<&str>) -> String {
    json!({
        "id": non_empty(&state.id, "chatcmpl-proxy"),
        "object": "chat.completion.chunk",
        "created": state.created,
        "model": state.model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    })
    .to_string()
}

fn chunk_str_with_usage(
    state: &StreamState,
    delta: Value,
    finish: Option<&str>,
    usage: Option<&Value>,
) -> String {
    let mut chunk = json!({
        "id": non_empty(&state.id, "chatcmpl-proxy"),
        "object": "chat.completion.chunk",
        "created": state.created,
        "model": state.model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    });
    if let Some(u) = usage {
        chunk["usage"] = convert_usage(Some(u));
    }
    chunk.to_string()
}

fn non_empty(s: &str, fallback: &str) -> String {
    if s.is_empty() {
        fallback.to_string()
    } else {
        s.to_string()
    }
}

/// Map Responses `usage` (`input_tokens`/`output_tokens`) to chat/completions
/// (`prompt_tokens`/`completion_tokens`).
fn convert_usage(usage: Option<&Value>) -> Value {
    let Some(u) = usage else {
        return Value::Null;
    };
    let prompt = u.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
    let completion = u.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
    let total = u
        .get("total_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(prompt + completion);
    json!({
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_event_in_one_chunk() {
        let mut acc = SseAccumulator::new();
        let events = acc.push("data: {\"a\":1}\n\n");
        assert_eq!(
            events,
            vec![SseEvent {
                event: String::new(),
                data: "{\"a\":1}".to_string()
            }]
        );
    }

    #[test]
    fn buffers_an_event_split_across_chunks() {
        let mut acc = SseAccumulator::new();
        assert!(acc.push("data: {\"a\":").is_empty());
        assert!(acc.push("1}").is_empty());
        let events = acc.push("\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"a\":1}");
    }

    #[test]
    fn yields_multiple_events_from_one_chunk() {
        let mut acc = SseAccumulator::new();
        let events = acc.push("data: 1\n\ndata: 2\n\n");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "1");
        assert_eq!(events[1].data, "2");
    }

    #[test]
    fn joins_multiline_data_and_reads_event_field() {
        let mut acc = SseAccumulator::new();
        let events = acc.push("event: response.delta\ndata: line1\ndata: line2\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "response.delta");
        assert_eq!(events[0].data, "line1\nline2");
    }

    #[test]
    fn normalizes_crlf_boundaries() {
        let mut acc = SseAccumulator::new();
        let events = acc.push("data: x\r\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "x");
    }

    #[test]
    fn ignores_comment_lines_and_preserves_done_sentinel() {
        let mut acc = SseAccumulator::new();
        let events = acc.push(": keep-alive\n\ndata: [DONE]\n\n");
        // The comment-only block yields no event; [DONE] is preserved verbatim.
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "[DONE]");
    }

    #[test]
    fn finish_flushes_a_trailing_event_without_blank_line() {
        let mut acc = SseAccumulator::new();
        assert!(acc.push("data: tail").is_empty());
        let last = acc.finish();
        assert_eq!(last.map(|e| e.data), Some("tail".to_string()));
    }

    #[test]
    fn finish_is_empty_when_buffer_has_no_fields() {
        let mut acc = SseAccumulator::new();
        acc.push("data: done\n\n");
        assert_eq!(acc.finish(), None);
    }
}

#[cfg(test)]
mod openai_responses_tests {
    use super::*;

    fn conv() -> OpenAIResponsesConverter {
        OpenAIResponsesConverter::new()
    }

    #[test]
    fn request_splits_system_into_instructions_and_maps_input() {
        let body = json!({
            "model": "gpt-5",
            "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "hi"}
            ],
            "max_tokens": 128,
            "temperature": 0.4,
            "stream": true,
            "reasoning_effort": "high"
        });
        let out = conv().convert_request(&body);
        assert_eq!(out["model"], json!("gpt-5"));
        assert_eq!(out["instructions"], json!("be brief"));
        assert_eq!(out["input"], json!([{"role": "user", "content": "hi"}]));
        assert_eq!(out["max_output_tokens"], json!(128));
        assert_eq!(out["temperature"], json!(0.4));
        assert_eq!(out["stream"], json!(true));
        assert_eq!(out["reasoning"], json!({"effort": "high", "summary": "auto"}));
    }

    #[test]
    fn request_flattens_tools_and_maps_tool_messages() {
        let body = json!({
            "model": "gpt-5",
            "messages": [
                {"role": "user", "content": "weather?"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "getw", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "sunny"}
            ],
            "tools": [
                {"type": "function", "function": {"name": "getw", "description": "d", "parameters": {"type": "object"}}}
            ]
        });
        let out = conv().convert_request(&body);
        assert_eq!(
            out["tools"],
            json!([{"type": "function", "name": "getw", "description": "d", "parameters": {"type": "object"}}])
        );
        let input = out["input"].as_array().unwrap();
        assert_eq!(input[0], json!({"role": "user", "content": "weather?"}));
        assert_eq!(
            input[1],
            json!({"type": "function_call", "call_id": "call_1", "name": "getw", "arguments": "{}"})
        );
        assert_eq!(
            input[2],
            json!({"type": "function_call_output", "call_id": "call_1", "output": "sunny"})
        );
    }

    #[test]
    fn response_maps_text_reasoning_and_usage() {
        let upstream = json!({
            "id": "resp_1",
            "model": "gpt-5",
            "created_at": 123,
            "output": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hello"}]}
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
        });
        let out = conv().convert_response(&upstream);
        assert_eq!(out["object"], json!("chat.completion"));
        assert_eq!(out["id"], json!("resp_1"));
        assert_eq!(out["created"], json!(123));
        let choice = &out["choices"][0];
        assert_eq!(choice["message"]["content"], json!("hello"));
        assert_eq!(choice["message"]["reasoning_content"], json!("thinking"));
        assert_eq!(choice["finish_reason"], json!("stop"));
        assert_eq!(out["usage"], json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}));
    }

    #[test]
    fn response_maps_function_call_to_tool_calls() {
        let upstream = json!({
            "id": "resp_2",
            "model": "gpt-5",
            "output": [
                {"type": "function_call", "call_id": "c1", "name": "getw", "arguments": "{\"x\":1}"}
            ]
        });
        let out = conv().convert_response(&upstream);
        let choice = &out["choices"][0];
        assert_eq!(choice["finish_reason"], json!("tool_calls"));
        assert_eq!(choice["message"]["content"], Value::Null);
        assert_eq!(
            choice["message"]["tool_calls"],
            json!([{"id": "c1", "type": "function", "function": {"name": "getw", "arguments": "{\"x\":1}"}}])
        );
    }

    fn ev(event: &str, data: Value) -> SseEvent {
        SseEvent {
            event: event.to_string(),
            data: data.to_string(),
        }
    }

    #[test]
    fn stream_text_deltas_emit_role_then_content() {
        let c = conv();
        let mut state = StreamState::default();
        assert!(c
            .convert_stream_event(
                &ev("response.created", json!({"response": {"id": "r1", "model": "gpt-5", "created_at": 9}})),
                &mut state
            )
            .is_empty());
        let first = c.convert_stream_event(&ev("response.output_text.delta", json!({"delta": "he"})), &mut state);
        assert_eq!(first.len(), 2);
        let role: Value = serde_json::from_str(&first[0]).unwrap();
        assert_eq!(role["choices"][0]["delta"]["role"], json!("assistant"));
        assert_eq!(role["id"], json!("r1"));
        assert_eq!(role["model"], json!("gpt-5"));
        let content: Value = serde_json::from_str(&first[1]).unwrap();
        assert_eq!(content["choices"][0]["delta"]["content"], json!("he"));

        let second = c.convert_stream_event(&ev("response.output_text.delta", json!({"delta": "llo"})), &mut state);
        assert_eq!(second.len(), 1);
        let content2: Value = serde_json::from_str(&second[0]).unwrap();
        assert_eq!(content2["choices"][0]["delta"]["content"], json!("llo"));
    }

    #[test]
    fn stream_reasoning_delta_maps_to_reasoning_content() {
        let c = conv();
        let mut state = StreamState::default();
        let out = c.convert_stream_event(
            &ev("response.reasoning_summary_text.delta", json!({"delta": "hmm"})),
            &mut state,
        );
        // role chunk + reasoning chunk
        assert_eq!(out.len(), 2);
        let reasoning: Value = serde_json::from_str(&out[1]).unwrap();
        assert_eq!(reasoning["choices"][0]["delta"]["reasoning_content"], json!("hmm"));
    }

    #[test]
    fn stream_function_call_emits_header_and_argument_deltas() {
        let c = conv();
        let mut state = StreamState::default();
        let added = c.convert_stream_event(
            &ev(
                "response.output_item.added",
                json!({"item": {"id": "fc_1", "type": "function_call", "call_id": "c1", "name": "getw"}}),
            ),
            &mut state,
        );
        // role chunk + tool header
        assert_eq!(added.len(), 2);
        let header: Value = serde_json::from_str(&added[1]).unwrap();
        let tc = &header["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(tc["index"], json!(0));
        assert_eq!(tc["id"], json!("c1"));
        assert_eq!(tc["function"]["name"], json!("getw"));

        let arg = c.convert_stream_event(
            &ev("response.function_call_arguments.delta", json!({"item_id": "fc_1", "delta": "{\"x\""})),
            &mut state,
        );
        assert_eq!(arg.len(), 1);
        let arg_chunk: Value = serde_json::from_str(&arg[0]).unwrap();
        let atc = &arg_chunk["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(atc["index"], json!(0));
        assert_eq!(atc["function"]["arguments"], json!("{\"x\""));
    }

    #[test]
    fn stream_completed_emits_finish_usage_and_done() {
        let c = conv();
        let mut state = StreamState {
            saw_tool_call: true,
            ..Default::default()
        };
        let out = c.convert_stream_event(
            &ev(
                "response.completed",
                json!({"response": {"usage": {"input_tokens": 3, "output_tokens": 4, "total_tokens": 7}}}),
            ),
            &mut state,
        );
        assert_eq!(out.len(), 2);
        let finish: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(finish["choices"][0]["finish_reason"], json!("tool_calls"));
        assert_eq!(finish["usage"]["prompt_tokens"], json!(3));
        assert_eq!(out[1], "[DONE]");
        assert!(state.finished);
        // Events after completion are ignored.
        assert!(c
            .convert_stream_event(&ev("response.output_text.delta", json!({"delta": "x"})), &mut state)
            .is_empty());
    }

    #[test]
    fn stream_dispatches_on_data_type_when_event_field_absent() {
        let c = conv();
        let mut state = StreamState::default();
        let out = c.convert_stream_event(
            &ev("", json!({"type": "response.output_text.delta", "delta": "hi"})),
            &mut state,
        );
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn stream_ignores_done_sentinel_and_bad_json() {
        let c = conv();
        let mut state = StreamState::default();
        assert!(c
            .convert_stream_event(&SseEvent { event: String::new(), data: "[DONE]".into() }, &mut state)
            .is_empty());
        assert!(c
            .convert_stream_event(&SseEvent { event: String::new(), data: "not json".into() }, &mut state)
            .is_empty());
    }
}
