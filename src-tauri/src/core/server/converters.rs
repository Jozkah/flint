//! Translating-gateway support for the proxy.
//!
//! Flint's proxy accepts OpenAI chat/completions and, for OpenAI-compatible
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
    /// Bytes at the front of `buf` already scanned and known to hold no
    /// event terminator, so each chunk is scanned once, not rescanned whole.
    scanned: usize,
    utf8: Utf8ChunkDecoder,
}

/// Largest event the accumulator will hold while waiting for its blank line.
const MAX_SSE_EVENT_BYTES: usize = 4 * 1024 * 1024;

/// Decodes a byte stream as UTF-8 one network chunk at a time, holding back
/// a multi-byte character split across a chunk boundary until the rest of it
/// arrives. Decoding each chunk on its own with `from_utf8_lossy` turned such a
/// character into U+FFFD replacement characters (#195).
#[derive(Debug, Default)]
pub struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    /// The text completed by `chunk`. Genuinely invalid bytes still become
    /// U+FFFD; only an incomplete sequence at the very end is held back.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let cut = self.pending.len() - incomplete_utf8_tail(&self.pending);
        let text = String::from_utf8_lossy(&self.pending[..cut]).into_owned();
        self.pending.drain(..cut);
        text
    }

    /// Whatever is still held back when the stream ends (lossily decoded).
    pub fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

/// How many bytes at the end of `bytes` begin a UTF-8 sequence that is not
/// complete yet (0 to 3).
fn incomplete_utf8_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let byte = bytes[bytes.len() - back];
        if byte & 0xC0 == 0x80 {
            // A continuation byte: keep looking for the lead byte.
            continue;
        }
        let needed = match byte {
            0xF0..=0xF7 => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if needed > back { back } else { 0 };
    }
    0
}

impl SseAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed raw response bytes; like [`SseAccumulator::push`], but a UTF-8
    /// character split across two network chunks is reassembled instead of
    /// being corrupted.
    pub fn push_bytes(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let text = self.utf8.push(chunk);
        self.push(&text)
    }

    /// Feed a chunk of the response body; returns every event completed by it.
    pub fn push(&mut self, chunk: &str) -> Vec<SseEvent> {
        // Normalize CRLF so boundary detection only has to look for "\n\n".
        self.buf.push_str(&chunk.replace("\r\n", "\n"));
        let mut events = Vec::new();
        loop {
            // Resume one byte early: a terminator can straddle two chunks.
            let mut from = self.scanned.saturating_sub(1).min(self.buf.len());
            while !self.buf.is_char_boundary(from) {
                from -= 1;
            }
            let Some(rel) = self.buf[from..].find("\n\n") else {
                self.scanned = self.buf.len();
                break;
            };
            let idx = from + rel;
            let raw: String = self.buf.drain(..idx + 2).collect();
            self.scanned = 0;
            if let Some(ev) = parse_event(&raw) {
                events.push(ev);
            }
        }
        if self.buf.len() > MAX_SSE_EVENT_BYTES {
            // No terminator in 4 MiB: not an SSE stream worth buffering.
            self.buf.clear();
            self.scanned = 0;
            events.push(SseEvent {
                event: "error".to_string(),
                data: r#"{"type":"error","error":{"message":"upstream sent an event larger than 4 MiB"}}"#
                    .to_string(),
            });
        }
        events
    }

    /// Flush a final event that arrived without a terminating blank line (some
    /// servers omit it before closing the connection).
    pub fn finish(&mut self) -> Option<SseEvent> {
        let tail = self.utf8.finish();
        self.buf.push_str(&tail.replace("\r\n", "\n"));
        let raw = std::mem::take(&mut self.buf);
        self.scanned = 0;
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

/// Chat/completions parameters a converter may have to drop. Each converter
/// lists the ones it maps; the rest are reported once per request at debug level.
const CHAT_PARAMS: &[&str] = &[
    "frequency_penalty",
    "presence_penalty",
    "logit_bias",
    "logprobs",
    "top_logprobs",
    "n",
    "seed",
    "stop",
    "user",
    "response_format",
    "parallel_tool_calls",
    "top_k",
];

const RESPONSES_MAPPED: &[&str] = &["response_format", "parallel_tool_calls"];
const GEMINI_MAPPED: &[&str] = &[
    "stop",
    "seed",
    "presence_penalty",
    "frequency_penalty",
    "response_format",
    "top_k",
];
const ANTHROPIC_MAPPED: &[&str] = &["stop", "parallel_tool_calls", "top_k"];

/// Chat parameters present in `body` that the converter does not translate.
fn unmapped_params(body: &Value, mapped: &[&str]) -> Vec<&'static str> {
    CHAT_PARAMS
        .iter()
        .copied()
        .filter(|k| !mapped.contains(k) && body.get(*k).is_some_and(|v| !v.is_null()))
        .collect()
}

fn log_unmapped(converter: &str, body: &Value, mapped: &[&str]) {
    let dropped = unmapped_params(body, mapped);
    if !dropped.is_empty() {
        log::debug!("{converter}: dropping unsupported request fields {dropped:?}");
    }
}

/// `stop` is a string or an array of strings in chat/completions.
fn stop_sequences(body: &Value) -> Option<Vec<String>> {
    let list: Vec<String> = match body.get("stop")? {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => return None,
    };
    let list: Vec<String> = list.into_iter().filter(|s| !s.is_empty()).collect();
    (!list.is_empty()).then_some(list)
}

/// Drop JSON-schema keywords Gemini's `responseSchema` rejects.
fn gemini_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "$schema" | "additionalProperties" | "strict" | "$defs" | "definitions"
                    )
                })
                .map(|(k, v)| (k.clone(), gemini_schema(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(gemini_schema).collect()),
        other => other.clone(),
    }
}

/// How a provider route reuses a request prefix it has already seen.
///
/// Declared per route (`ProviderConfig.api_type`) instead of inferred from a
/// provider name at each call site, so "may this request carry a cache marker"
/// has one answer that a strict endpoint cannot disagree with. A route nobody
/// has classified resolves to [`CacheCapability::None`]: no marker is emitted
/// and nothing downstream assumes the route reports cache counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheCapability {
    /// Not known to cache, or not classified. Nothing is emitted for it.
    None,
    /// The provider reuses a byte-identical leading prefix by itself (OpenAI,
    /// DeepSeek and other chat/completions routes, OpenAI `/responses`, Gemini
    /// implicit caching). The request is shaped for it with a byte-stable
    /// prefix and carries no marker.
    Implicit,
    /// The provider caches only where the request says so (Anthropic
    /// `cache_control` breakpoints). The converter places them, and only a
    /// route that declares this is sent one.
    Explicit,
}

impl CacheCapability {
    /// The capability of the route that speaks `api_type`. The one place an
    /// `api_type` is mapped to a caching behavior; every converter reads its
    /// own answer from here so a new `api_type` is a decision in this match.
    pub fn for_api_type(api_type: Option<&str>) -> Self {
        match api_type {
            // Verbatim chat/completions.
            None | Some("openai") => CacheCapability::Implicit,
            Some("openai-responses") => CacheCapability::Implicit,
            // Gemini caches a repeated prefix itself. The explicit
            // `cachedContents` resource is a separate API this gateway does
            // not use, so there is nothing to place.
            Some("google") => CacheCapability::Implicit,
            Some("anthropic") => CacheCapability::Explicit,
            Some(_) => CacheCapability::None,
        }
    }

    /// The spelling `agent status` reports.
    pub fn as_str(self) -> &'static str {
        match self {
            CacheCapability::None => "none",
            CacheCapability::Implicit => "implicit",
            CacheCapability::Explicit => "explicit",
        }
    }
}

/// Translates an OpenAI chat/completions request to a provider's native wire
/// API and its response back. Implementors front a provider whose native API is
/// not chat/completions (OpenAI `/v1/responses`, Google `generateContent`,
/// Anthropic `/v1/messages`); the proxy selects one by `ProviderConfig.api_type`
/// and otherwise forwards verbatim.
pub trait UpstreamConverter: Send + Sync {
    /// Path suffix appended to the provider `base_url`. Derived from the request
    /// body because some APIs encode the model and action in the URL (Google:
    /// `/models/{model}:streamGenerateContent?alt=sse`).
    fn upstream_path(&self, body: &Value) -> String;

    /// Authorization header for the upstream request. Defaults to OpenAI-style
    /// `Authorization: Bearer`; providers using a different scheme (Google:
    /// `x-goog-api-key`) override this.
    fn auth_header(&self, key: &str) -> (&'static str, String) {
        ("authorization", format!("Bearer {key}"))
    }

    /// Fixed headers the native API requires (Anthropic: `anthropic-version`).
    fn extra_headers(&self) -> Vec<(&'static str, &'static str)> {
        Vec::new()
    }

    /// Additional headers derived from a credential. No provider needs any
    /// today; kept so a converter can add one without a signature change.
    fn credential_headers(&self, _key: &str) -> Vec<(&'static str, String)> {
        Vec::new()
    }

    /// How this route caches a request prefix. Required rather than defaulted:
    /// a converter added for a new `api_type` has to decide whether it may
    /// emit a cache marker, instead of inheriting an answer.
    fn cache_capability(&self) -> CacheCapability;

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
        Some("google") => Some(Box::new(GoogleGenerateContentConverter::new())),
        Some("anthropic") => Some(Box::new(AnthropicMessagesConverter::new())),
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
    /// Random per-stream prefix for invented Gemini call ids (Gemini sends none).
    pub call_prefix: String,
    pub finished: bool,
    /// Prompt tokens captured early (Anthropic sends them in `message_start`).
    pub input_tokens: i64,
    /// Anthropic's cache counts, as last reported. `None` until the provider
    /// sends one: an absent count is unknown, not zero.
    pub cache_read_input_tokens: Option<i64>,
    pub cache_creation_input_tokens: Option<i64>,
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

/// An image carried by an OpenAI `image_url` content part, in the two forms
/// every native API distinguishes: inline bytes, or a URL the provider fetches.
#[derive(Debug, PartialEq)]
enum ImageSource<'a> {
    Base64 { mime: &'a str, data: &'a str },
    Url(&'a str),
}

/// The images of a chat message `content`, in order. A malformed part is
/// skipped, the same way [`message_text`] skips any part it cannot read.
fn message_images(content: &Value) -> Vec<ImageSource<'_>> {
    let Value::Array(parts) = content else {
        return Vec::new();
    };
    parts
        .iter()
        .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("image_url"))
        .filter_map(|p| p.get("image_url")?.get("url")?.as_str())
        .filter_map(|url| match url.strip_prefix("data:") {
            Some(rest) => {
                let (mime, data) = rest.split_once(";base64,")?;
                (!mime.is_empty() && !data.is_empty()).then_some(ImageSource::Base64 { mime, data })
            }
            None => Some(ImageSource::Url(url)),
        })
        .collect()
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

/// A content-part array as Responses input items: the text first, then each
/// image. Responses takes a data URL and a remote URL in the same field.
fn responses_parts(content: &Value, images: Vec<ImageSource<'_>>) -> Vec<Value> {
    let text = message_text(content);
    let mut items = Vec::with_capacity(images.len() + 1);
    if !text.is_empty() {
        items.push(json!({"type": "input_text", "text": text}));
    }
    items.extend(images.into_iter().map(|image| {
        let url = match image {
            ImageSource::Base64 { mime, data } => format!("data:{mime};base64,{data}"),
            ImageSource::Url(url) => url.to_string(),
        };
        json!({"type": "input_image", "image_url": url})
    }));
    items
}

impl UpstreamConverter for OpenAIResponsesConverter {
    fn cache_capability(&self) -> CacheCapability {
        CacheCapability::for_api_type(Some("openai-responses"))
    }

    fn upstream_path(&self, _body: &Value) -> String {
        "/responses".to_string()
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
                        // An output with images is the item-list form, which
                        // is where Responses reads a tool's media; a text-only
                        // one stays a string, as before.
                        let images = message_images(&content);
                        let output = if images.is_empty() {
                            json!(message_text(&content))
                        } else {
                            Value::Array(responses_parts(&content, images))
                        };
                        input_items.push(json!({
                            "type": "function_call_output",
                            "call_id": msg.get("tool_call_id").cloned().unwrap_or(Value::Null),
                            "output": output,
                        }));
                    }
                    "assistant" if msg.get("tool_calls").is_some() => {
                        // The turn's text comes before its calls, as the model
                        // produced them.
                        let text = message_text(&content);
                        if !text.is_empty() {
                            input_items.push(json!({"role": "assistant", "content": text}));
                        }
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
                    }
                    _ => {
                        let images = message_images(&content);
                        let content = if images.is_empty() {
                            json!(message_text(&content))
                        } else {
                            Value::Array(responses_parts(&content, images))
                        };
                        input_items.push(json!({"role": role, "content": content}));
                    }
                }
            }
        }
        if !instructions.is_empty() {
            out["instructions"] = json!(instructions.join("\n\n"));
        }
        out["input"] = json!(input_items);
        // The full history is sent every turn, so nothing needs storing
        // server side.
        out["store"] = json!(false);

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
        if let Some(format) = body.get("response_format").and_then(|f| f.as_object()) {
            let mapped = match format.get("type").and_then(|t| t.as_str()) {
                Some("json_object") => Some(json!({"type": "json_object"})),
                Some("text") => Some(json!({"type": "text"})),
                Some("json_schema") => format.get("json_schema").map(|js| {
                    json!({
                        "type": "json_schema",
                        "name": js.get("name").cloned().unwrap_or(json!("response")),
                        "schema": js.get("schema").cloned().unwrap_or(json!({})),
                        "strict": js.get("strict").cloned().unwrap_or(json!(false)),
                    })
                }),
                _ => None,
            };
            if let Some(f) = mapped {
                out["text"] = json!({"format": f});
            }
        }
        if let Some(v) = body.get("parallel_tool_calls").filter(|v| v.is_boolean()) {
            out["parallel_tool_calls"] = v.clone();
        }
        log_unmapped("responses", body, RESPONSES_MAPPED);

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
            // Chat nests the name under `function`; Responses wants it flat.
            out["tool_choice"] = match tc.pointer("/function/name").and_then(|n| n.as_str()) {
                Some(name) if tc.get("type").and_then(|t| t.as_str()) == Some("function") => {
                    json!({"type": "function", "name": name})
                }
                _ => tc.clone(),
            };
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
        let saw_tool = !tool_calls.is_empty();
        if saw_tool {
            message["tool_calls"] = json!(tool_calls);
        }
        let finish_reason = responses_finish(upstream, saw_tool);

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
                    // An id never announced must not be glued onto call 0.
                    let Some(&idx) = state.tool_index.get(&key) else {
                        log::warn!("responses stream: argument delta for unknown item `{key}` dropped");
                        return out;
                    };
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
                let finish = match data.get("response") {
                    Some(resp) => responses_finish(resp, state.saw_tool_call),
                    None if state.saw_tool_call => "tool_calls",
                    None => "stop",
                };
                let usage = data
                    .get("response")
                    .and_then(|r| r.get("usage"))
                    .map(|u| convert_usage(Some(u)))
                    .filter(|u| !u.is_null());
                out.push(chunk_str_with_usage(
                    state,
                    json!({}),
                    Some(finish),
                    usage.as_ref(),
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

/// Chat `finish_reason` for a Responses object (or its stream `response`):
/// an incomplete response reports why, and a cut-off or filtered turn beats a
/// tool call because the call's arguments may be truncated.
fn responses_finish(resp: &Value, saw_tool: bool) -> &'static str {
    let reason = resp
        .pointer("/incomplete_details/reason")
        .and_then(|r| r.as_str())
        .unwrap_or("");
    let incomplete = resp.get("status").and_then(|s| s.as_str()) == Some("incomplete");
    match reason {
        "max_output_tokens" => "length",
        "content_filter" => "content_filter",
        _ if incomplete && !saw_tool => "length",
        _ if saw_tool => "tool_calls",
        _ => "stop",
    }
}

/// Fronts Google's Gemini `generateContent` API. The model and action are
/// encoded in the URL and streaming uses `?alt=sse`; auth is `x-goog-api-key`.
/// The registered provider `base_url` must include the API version, e.g.
/// `https://generativelanguage.googleapis.com/v1beta`.
#[derive(Debug, Default, Clone, Copy)]
pub struct GoogleGenerateContentConverter;

impl GoogleGenerateContentConverter {
    pub fn new() -> Self {
        Self
    }
}

/// Map a Gemini `finishReason` to a chat/completions `finish_reason`.
fn map_gemini_finish(reason: &str, saw_tool: bool) -> &'static str {
    // A cut-off turn beats a tool call: the call's arguments may be truncated.
    if reason == "MAX_TOKENS" {
        return "length";
    }
    if saw_tool {
        return "tool_calls";
    }
    match reason {
        "MAX_TOKENS" => "length",
        "SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" | "BLOCKLIST" => "content_filter",
        _ => "stop",
    }
}

/// Map Gemini `usageMetadata` to chat/completions usage.
fn convert_gemini_usage(usage: Option<&Value>) -> Value {
    let Some(u) = usage else {
        return Value::Null;
    };
    let prompt = u
        .get("promptTokenCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let candidates = u
        .get("candidatesTokenCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let thoughts = u
        .get("thoughtsTokenCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let completion = candidates + thoughts;
    let total = u
        .get("totalTokenCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(prompt + completion);
    let mut out = json!({
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
    });
    // `promptTokenCount` includes the cached content. Gemini only sends
    // `cachedContentTokenCount` when some of the prompt came from a cache, so
    // its absence says nothing and is not turned into a zero.
    if let Some(cached) = u.get("cachedContentTokenCount").and_then(|v| v.as_i64()) {
        out["prompt_tokens_details"] = json!({ "cached_tokens": cached });
    }
    out
}

/// Whether the requested model reads media nested in `functionResponse.parts`,
/// which Gemini added with its 3 series. The name is the only signal the
/// converter has, so an unrecognized name gets the sibling-part form that
/// every Gemini model accepts.
fn gemini_reads_function_response_parts(body: &Value) -> bool {
    let Some(model) = body.get("model").and_then(|m| m.as_str()) else {
        return false;
    };
    let name = model.rsplit('/').next().unwrap_or(model);
    name.strip_prefix("gemini-")
        .and_then(|rest| rest.split(['.', '-']).next())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 3)
}

/// A model name as one safe URL path segment: anything outside `[A-Za-z0-9._-]`
/// is percent-encoded, and a bare dot-segment is neutralised, so a crafted
/// name cannot add path, query or fragment parts to the upstream URL.
fn escape_model_segment(model: &str) -> String {
    let mut out = String::with_capacity(model.len());
    for b in model.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    if out == "." || out == ".." {
        out = out.replace('.', "%2E");
    }
    out
}

impl UpstreamConverter for GoogleGenerateContentConverter {
    fn cache_capability(&self) -> CacheCapability {
        CacheCapability::for_api_type(Some("google"))
    }

    fn upstream_path(&self, body: &Value) -> String {
        let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("");
        let model = escape_model_segment(model.strip_prefix("models/").unwrap_or(model));
        let streaming = body
            .get("stream")
            .and_then(|s| s.as_bool())
            .unwrap_or(false);
        if streaming {
            format!("/models/{model}:streamGenerateContent?alt=sse")
        } else {
            format!("/models/{model}:generateContent")
        }
    }

    fn auth_header(&self, key: &str) -> (&'static str, String) {
        ("x-goog-api-key", key.to_string())
    }

    fn convert_request(&self, body: &Value) -> Value {
        // tool_call_id -> function name, so tool results become functionResponse
        // parts (Gemini keys them by name, not call id). Rebuilt in message
        // order and overwritten at each assistant turn: ids from older replies
        // (`call_0` from a pre-fix history) must resolve to the nearest
        // preceding call, not the last one in the whole history.
        let mut call_names: HashMap<String, String> = HashMap::new();
        // True while the last pushed content is a run of tool results, so the
        // next tool result joins it (Gemini wants all responses to one model
        // turn's calls in a single user content).
        let mut last_is_tool_results = false;
        let mut contents: Vec<Value> = Vec::new();
        let mut system_parts: Vec<Value> = Vec::new();
        if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
            for msg in messages {
                let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                let content = msg.get("content").cloned().unwrap_or(Value::Null);
                let was_tool_results = std::mem::take(&mut last_is_tool_results);
                match role {
                    "system" | "developer" => {
                        last_is_tool_results = was_tool_results;
                        system_parts.push(json!({"text": message_text(&content)}));
                    }
                    "assistant" => {
                        let mut parts: Vec<Value> = Vec::new();
                        let text = message_text(&content);
                        if !text.is_empty() {
                            parts.push(json!({"text": text}));
                        }
                        if let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) {
                            for call in calls {
                                let func = call.get("function");
                                if let (Some(id), Some(n)) = (
                                    call.get("id").and_then(|v| v.as_str()),
                                    func.and_then(|f| f.get("name")).and_then(|n| n.as_str()),
                                ) {
                                    call_names.insert(id.to_string(), n.to_string());
                                }
                                let name = func
                                    .and_then(|f| f.get("name"))
                                    .cloned()
                                    .unwrap_or(Value::Null);
                                let args_str = func
                                    .and_then(|f| f.get("arguments"))
                                    .and_then(|a| a.as_str())
                                    .unwrap_or("{}");
                                let args: Value =
                                    serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
                                parts.push(json!({"functionCall": {"name": name, "args": args}}));
                            }
                        }
                        if !parts.is_empty() {
                            contents.push(json!({"role": "model", "parts": parts}));
                        }
                    }
                    "tool" => {
                        let call_id = msg
                            .get("tool_call_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let name = call_names
                            .get(call_id)
                            .cloned()
                            .unwrap_or_else(|| call_id.to_string());
                        let text = message_text(&content);
                        // Gemini requires the functionResponse `response` to be an object.
                        let response: Value = serde_json::from_str(&text)
                            .ok()
                            .filter(|v: &Value| v.is_object())
                            .unwrap_or_else(|| json!({"result": text}));
                        let mut function_response = json!({"name": name, "response": response});
                        let mut parts: Vec<Value> = Vec::new();
                        // `functionResponse.parts` takes inline bytes only, and
                        // only Gemini 3+ reads it. Earlier models get the image
                        // as a sibling part of the same turn instead, which is
                        // the form they accept.
                        let images: Vec<Value> = message_images(&content)
                            .into_iter()
                            .filter_map(|image| match image {
                                ImageSource::Base64 { mime, data } => {
                                    Some(json!({"inlineData": {"mimeType": mime, "data": data}}))
                                }
                                ImageSource::Url(_) => None,
                            })
                            .collect();
                        let nested = gemini_reads_function_response_parts(body);
                        if nested && !images.is_empty() {
                            function_response["parts"] = Value::Array(images.clone());
                        }
                        parts.push(json!({"functionResponse": function_response}));
                        if !nested {
                            parts.extend(images);
                        }
                        let joined = was_tool_results
                            && contents.last_mut().is_some_and(|last| {
                                let Some(existing) =
                                    last.get_mut("parts").and_then(|p| p.as_array_mut())
                                else {
                                    return false;
                                };
                                // Keep every functionResponse ahead of the
                                // sibling image parts of earlier results.
                                let at = existing
                                    .iter()
                                    .rposition(|p| p.get("functionResponse").is_some())
                                    .map_or(existing.len(), |i| i + 1);
                                let mut tail = parts.clone().into_iter();
                                if let Some(fr) = tail.next() {
                                    existing.insert(at, fr);
                                }
                                existing.extend(tail);
                                true
                            });
                        if !joined {
                            contents.push(json!({"role": "user", "parts": parts}));
                        }
                        last_is_tool_results = true;
                    }
                    _ => {
                        let mut parts: Vec<Value> = Vec::new();
                        let text = message_text(&content);
                        let images = message_images(&content);
                        if !text.is_empty() || images.is_empty() {
                            parts.push(json!({"text": text}));
                        }
                        parts.extend(images.into_iter().map(|image| match image {
                            ImageSource::Base64 { mime, data } => {
                                json!({"inlineData": {"mimeType": mime, "data": data}})
                            }
                            // A URL carries no MIME type; Gemini requires one,
                            // and JPEG is the common default for photos.
                            ImageSource::Url(url) => json!({"fileData": {
                                "mimeType": "image/jpeg", "fileUri": url,
                            }}),
                        }));
                        contents.push(json!({"role": "user", "parts": parts}));
                    }
                }
            }
        }

        let mut out = json!({"contents": contents});
        if !system_parts.is_empty() {
            out["systemInstruction"] = json!({"parts": system_parts});
        }

        let mut gen_config = json!({});
        if let Some(v) = body.get("temperature") {
            gen_config["temperature"] = v.clone();
        }
        if let Some(v) = body.get("top_p") {
            gen_config["topP"] = v.clone();
        }
        if let Some(v) = body
            .get("max_tokens")
            .or_else(|| body.get("max_completion_tokens"))
        {
            gen_config["maxOutputTokens"] = v.clone();
        }
        if let Some(stops) = stop_sequences(body) {
            gen_config["stopSequences"] = json!(stops);
        }
        for (src, dst) in [
            ("seed", "seed"),
            ("presence_penalty", "presencePenalty"),
            ("frequency_penalty", "frequencyPenalty"),
            ("top_k", "topK"),
        ] {
            if let Some(v) = body.get(src).filter(|v| v.is_number()) {
                gen_config[dst] = v.clone();
            }
        }
        if let Some(format) = body.get("response_format") {
            match format.get("type").and_then(|t| t.as_str()) {
                Some("json_object") => {
                    gen_config["responseMimeType"] = json!("application/json");
                }
                Some("json_schema") => {
                    gen_config["responseMimeType"] = json!("application/json");
                    if let Some(schema) = format.get("json_schema").and_then(|j| j.get("schema")) {
                        gen_config["responseSchema"] = gemini_schema(schema);
                    }
                }
                _ => {}
            }
        }
        log_unmapped("gemini", body, GEMINI_MAPPED);
        // "none" leaves the model default (no forced thinking); the low
        // tiers get a small fixed budget instead of unbounded dynamic thinking.
        match body.get("reasoning_effort").and_then(|e| e.as_str()) {
            None | Some("none") => {}
            Some("minimal" | "low") => {
                gen_config["thinkingConfig"] =
                    json!({"thinkingBudget": 1024, "includeThoughts": true});
            }
            Some(_) => {
                gen_config["thinkingConfig"] =
                    json!({"thinkingBudget": -1, "includeThoughts": true});
            }
        }
        if gen_config.as_object().is_some_and(|o| !o.is_empty()) {
            out["generationConfig"] = gen_config;
        }

        if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
            let decls: Vec<Value> = tools
                .iter()
                .filter_map(|t| {
                    let func = t.get("function")?;
                    Some(json!({
                        "name": func.get("name").cloned().unwrap_or(Value::Null),
                        "description": func.get("description").cloned().unwrap_or(Value::Null),
                        "parameters": func.get("parameters").cloned().unwrap_or(json!({})),
                    }))
                })
                .collect();
            if !decls.is_empty() {
                out["tools"] = json!([{"functionDeclarations": decls}]);
            }
        }
        if let Some(mode) = body.get("tool_choice").and_then(|c| c.as_str()) {
            let g_mode = match mode {
                "none" => "NONE",
                "required" => "ANY",
                _ => "AUTO",
            };
            out["toolConfig"] = json!({"functionCallingConfig": {"mode": g_mode}});
        }

        out
    }

    fn convert_response(&self, upstream: &Value) -> Value {
        // Same conditions the stream path ends as an error (#184).
        if let Some(message) = gemini_stream_error(upstream) {
            return json!({"error": {"message": message, "type": "upstream_error"}});
        }
        let call_prefix = new_gemini_call_prefix();
        let candidate = upstream
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first());
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();

        if let Some(parts) = candidate
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
        {
            for part in parts {
                if let Some(fc) = part.get("functionCall") {
                    let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                    tool_calls.push(json!({
                        "id": format!("call_{call_prefix}_{}", tool_calls.len()),
                        "type": "function",
                        "function": {
                            "name": fc.get("name").cloned().unwrap_or(Value::Null),
                            "arguments": serde_json::to_string(&args).unwrap_or_default(),
                        }
                    }));
                } else if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    if part
                        .get("thought")
                        .and_then(|t| t.as_bool())
                        .unwrap_or(false)
                    {
                        reasoning.push_str(text);
                    } else {
                        content.push_str(text);
                    }
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
        let saw_tool = !tool_calls.is_empty();
        if saw_tool {
            message["tool_calls"] = json!(tool_calls);
        }
        let raw_finish = candidate
            .and_then(|c| c.get("finishReason"))
            .and_then(|r| r.as_str())
            .unwrap_or("STOP");
        let finish_reason = map_gemini_finish(raw_finish, saw_tool);
        if raw_finish == "SAFETY" && content.is_empty() && !saw_tool {
            message["content"] = json!("The response was blocked by the provider's safety filter.");
        }

        json!({
            "id": upstream.get("responseId").cloned().unwrap_or_else(|| json!("chatcmpl-proxy")),
            "object": "chat.completion",
            "created": 0,
            "model": upstream.get("modelVersion").cloned().unwrap_or(Value::Null),
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }],
            "usage": convert_gemini_usage(upstream.get("usageMetadata")),
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
        if let Some(model) = data.get("modelVersion").and_then(|v| v.as_str()) {
            if state.model.is_empty() {
                state.model = model.to_string();
            }
        }
        if let Some(id) = data.get("responseId").and_then(|v| v.as_str()) {
            if state.id.is_empty() {
                state.id = id.to_string();
            }
        }

        // A mid-stream failure arrives as a top-level `error` object, and a
        // prompt Gemini refuses as `promptFeedback.blockReason` with no
        // candidates. Both must end the stream as an error, not as a short
        // successful answer (#184).
        if let Some(message) = gemini_stream_error(&data) {
            return stream_error(state, &message);
        }

        let mut out: Vec<String> = Vec::new();
        let candidate = data
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first());

        if let Some(parts) = candidate
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
        {
            for part in parts {
                if let Some(fc) = part.get("functionCall") {
                    let idx = state.next_tool_index;
                    state.next_tool_index += 1;
                    state.saw_tool_call = true;
                    if state.call_prefix.is_empty() {
                        state.call_prefix = new_gemini_call_prefix();
                    }
                    push_role_chunk(state, &mut out);
                    let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                    out.push(chunk_str(
                        state,
                        json!({"tool_calls": [{
                            "index": idx,
                            "id": format!("call_{}_{idx}", state.call_prefix),
                            "type": "function",
                            "function": {
                                "name": fc.get("name").cloned().unwrap_or(Value::Null),
                                "arguments": serde_json::to_string(&args).unwrap_or_default(),
                            }
                        }]}),
                        None,
                    ));
                } else if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    push_role_chunk(state, &mut out);
                    let key = if part
                        .get("thought")
                        .and_then(|t| t.as_bool())
                        .unwrap_or(false)
                    {
                        "reasoning_content"
                    } else {
                        "content"
                    };
                    out.push(chunk_str(state, json!({ key: text }), None));
                }
            }
        }

        if let Some(reason) = candidate
            .and_then(|c| c.get("finishReason"))
            .and_then(|r| r.as_str())
        {
            let finish = map_gemini_finish(reason, state.saw_tool_call);
            let usage = data
                .get("usageMetadata")
                .map(|u| convert_gemini_usage(Some(u)))
                .filter(|u| !u.is_null());
            out.push(chunk_str_with_usage(
                state,
                json!({}),
                Some(finish),
                usage.as_ref(),
            ));
            out.push("[DONE]".to_string());
            state.finished = true;
        }
        out
    }
}

/// Anthropic requires a `max_tokens`; chat/completions may omit it.
const ANTHROPIC_DEFAULT_MAX_TOKENS: i64 = 4096;

/// Fronts Anthropic's `/v1/messages` API. Auth is `x-api-key` plus a fixed
/// `anthropic-version` header. The registered provider `base_url` should include
/// the version prefix, e.g. `https://api.anthropic.com/v1`.
#[derive(Debug, Default, Clone, Copy)]
pub struct AnthropicMessagesConverter;

impl AnthropicMessagesConverter {
    pub fn new() -> Self {
        Self
    }
}

fn map_anthropic_finish(reason: &str, saw_tool: bool) -> &'static str {
    // A cut-off turn beats a tool call: the call's arguments may be truncated.
    if reason == "max_tokens" {
        return "length";
    }
    if saw_tool {
        return "tool_calls";
    }
    match reason {
        "max_tokens" => "length",
        "tool_use" => "tool_calls",
        "refusal" => "content_filter",
        _ => "stop",
    }
}

/// Anthropic usage in chat/completions terms.
///
/// Anthropic's `input_tokens` excludes both cache counts, while
/// chat/completions' `prompt_tokens` is every prompt token, cached or not. So
/// the prompt total is the sum of all three, the cache read goes where OpenAI
/// puts it (`prompt_tokens_details.cached_tokens`), and the creation count is
/// passed through under Anthropic's own name -- there is no chat/completions
/// field for it. The creation count is part of the prompt total and of its
/// uncached share; it is never added a second time.
///
/// A cache count the provider did not send is left out, not written as zero.
fn anthropic_usage(
    input_tokens: i64,
    output_tokens: i64,
    cache_read: Option<i64>,
    cache_creation: Option<i64>,
) -> Value {
    let prompt = input_tokens + cache_read.unwrap_or(0) + cache_creation.unwrap_or(0);
    let mut usage = json!({
        "prompt_tokens": prompt,
        "completion_tokens": output_tokens,
        "total_tokens": prompt + output_tokens,
    });
    if let Some(read) = cache_read {
        usage["prompt_tokens_details"] = json!({ "cached_tokens": read });
    }
    if let Some(creation) = cache_creation {
        usage["cache_creation_input_tokens"] = json!(creation);
    }
    usage
}

fn anthropic_cache_counts(usage: Option<&Value>) -> (Option<i64>, Option<i64>) {
    let read = usage
        .and_then(|u| u.get("cache_read_input_tokens"))
        .and_then(|v| v.as_i64());
    let creation = usage
        .and_then(|u| u.get("cache_creation_input_tokens"))
        .and_then(|v| v.as_i64());
    (read, creation)
}

/// A content-part array as Anthropic blocks: the text first, then each image.
/// The marker Anthropic reads as "cache everything up to and including this
/// block". Ephemeral is the only type the API defines.
fn ephemeral_cache_marker() -> Value {
    json!({"type": "ephemeral"})
}

/// The `system` field as text blocks, with a cache breakpoint on the first
/// block of the real prompt.
///
/// The first system message is the stable head the loop writes once per
/// session; later ones are appended updates. Marking the head keeps the cached
/// prefix intact when an update lands behind it. Joined, the blocks read as the
/// same text the plain path sends.
fn anthropic_system_blocks(system: &[String]) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    if let Some((head, tail)) = system.split_first() {
        blocks.push(json!({
            "type": "text",
            "text": head,
            "cache_control": ephemeral_cache_marker(),
        }));
        if !tail.is_empty() {
            blocks.push(json!({"type": "text", "text": tail.join("\n\n")}));
        }
    }
    Value::Array(blocks)
}

fn anthropic_blocks(content: &Value, images: Vec<ImageSource<'_>>) -> Vec<Value> {
    let text = message_text(content);
    let mut blocks = Vec::with_capacity(images.len() + 1);
    if !text.is_empty() {
        blocks.push(json!({"type": "text", "text": text}));
    }
    blocks.extend(images.into_iter().map(|image| match image {
        ImageSource::Base64 { mime, data } => json!({
            "type": "image",
            "source": {"type": "base64", "media_type": mime, "data": data},
        }),
        ImageSource::Url(url) => json!({
            "type": "image",
            "source": {"type": "url", "url": url},
        }),
    }));
    blocks
}

/// Append `blocks` to the last message when it shares `role`, else start a new
/// one. Anthropic rejects consecutive same-role messages, so tool results and
/// adjacent turns must be merged.
fn push_merged(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(|r| r.as_str()) == Some(role) {
            if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                arr.extend(blocks);
                return;
            }
        }
    }
    messages.push(json!({"role": role, "content": blocks}));
}

/// Claude models that reject `temperature`/`top_p`/`top_k` with a 400.
fn anthropic_rejects_sampling(model: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-",
        "claude-mythos-",
    ];
    PREFIXES.iter().any(|p| model.starts_with(p))
}

/// Claude models that reject forced `tool_choice` (`any` / named `tool`).
fn anthropic_rejects_forced_tool_choice(model: &str) -> bool {
    const PREFIXES: &[&str] = &["claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1"];
    PREFIXES.iter().any(|p| model.starts_with(p))
}

impl UpstreamConverter for AnthropicMessagesConverter {
    fn cache_capability(&self) -> CacheCapability {
        CacheCapability::for_api_type(Some("anthropic"))
    }

    fn upstream_path(&self, _body: &Value) -> String {
        "/messages".to_string()
    }

    fn auth_header(&self, key: &str) -> (&'static str, String) {
        ("x-api-key", key.to_string())
    }

    fn extra_headers(&self) -> Vec<(&'static str, &'static str)> {
        vec![("anthropic-version", "2023-06-01")]
    }

    fn convert_request(&self, body: &Value) -> Value {
        let mut out = json!({});
        if let Some(model) = body.get("model") {
            out["model"] = model.clone();
        }
        let mut max_tokens = body
            .get("max_tokens")
            .or_else(|| body.get("max_completion_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(ANTHROPIC_DEFAULT_MAX_TOKENS);
        // Extended thinking only on an explicit effort. Anthropic requires
        // `max_tokens` above the budget and rejects sampling parameters with it.
        let thinking_budget: Option<i64> =
            match body.get("reasoning_effort").and_then(|e| e.as_str()) {
                Some("low") => Some(1024),
                Some("medium") => Some(4096),
                Some("high") => Some(8192),
                _ => None,
            };
        if let Some(budget) = thinking_budget {
            if max_tokens <= budget {
                max_tokens = budget + ANTHROPIC_DEFAULT_MAX_TOKENS;
            }
            out["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
        }
        out["max_tokens"] = json!(max_tokens);
        // Newer Claude models reject sampling parameters with a 400, so they are
        // forwarded only to models that still accept them.
        let model_id = body.get("model").and_then(|m| m.as_str()).unwrap_or("");
        let sampling_ok = !anthropic_rejects_sampling(model_id) && thinking_budget.is_none();
        for key in ["temperature", "top_p", "top_k", "stream"] {
            if key != "stream" && !sampling_ok {
                continue;
            }
            if let Some(v) = body.get(key) {
                out[key] = v.clone();
            }
        }

        if let Some(stops) = stop_sequences(body) {
            out["stop_sequences"] = json!(stops);
        }
        log_unmapped("anthropic", body, ANTHROPIC_MAPPED);

        let mut system: Vec<String> = Vec::new();
        let mut messages: Vec<Value> = Vec::new();
        if let Some(msgs) = body.get("messages").and_then(|m| m.as_array()) {
            for msg in msgs {
                let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                let content = msg.get("content").cloned().unwrap_or(Value::Null);
                match role {
                    "system" | "developer" => system.push(message_text(&content)),
                    "assistant" => {
                        let mut blocks: Vec<Value> = Vec::new();
                        let text = message_text(&content);
                        if !text.is_empty() {
                            blocks.push(json!({"type": "text", "text": text}));
                        }
                        if let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) {
                            for call in calls {
                                let func = call.get("function");
                                let args_str = func
                                    .and_then(|f| f.get("arguments"))
                                    .and_then(|a| a.as_str())
                                    .unwrap_or("{}");
                                let input: Value =
                                    serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
                                blocks.push(json!({
                                    "type": "tool_use",
                                    "id": call.get("id").cloned().unwrap_or(Value::Null),
                                    "name": func.and_then(|f| f.get("name")).cloned().unwrap_or(Value::Null),
                                    "input": input,
                                }));
                            }
                        }
                        push_merged(&mut messages, "assistant", blocks);
                    }
                    "tool" => {
                        // A result with images uses the block-list form of
                        // `tool_result.content`, which is where Anthropic reads
                        // a tool's media; a text-only one stays a string.
                        let images = message_images(&content);
                        let result = if images.is_empty() {
                            json!(message_text(&content))
                        } else {
                            Value::Array(anthropic_blocks(&content, images))
                        };
                        push_merged(
                            &mut messages,
                            "user",
                            vec![json!({
                                "type": "tool_result",
                                "tool_use_id": msg.get("tool_call_id").cloned().unwrap_or(Value::Null),
                                "content": result,
                            })],
                        );
                    }
                    _ => {
                        let images = message_images(&content);
                        let mut blocks = anthropic_blocks(&content, images);
                        if blocks.is_empty() {
                            // Anthropic rejects empty text blocks; a placeholder
                            // only when the whole message has nothing else.
                            blocks.push(json!({"type": "text", "text": "(empty)"}));
                        }
                        push_merged(&mut messages, "user", blocks);
                    }
                }
            }
        }
        out["messages"] = json!(messages);
        let explicit = self.cache_capability() == CacheCapability::Explicit;
        if !system.is_empty() {
            out["system"] = if explicit {
                anthropic_system_blocks(&system)
            } else {
                json!(system.join("\n\n"))
            };
        }

        if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
            let mapped: Vec<Value> = tools
                .iter()
                .filter_map(|t| {
                    let func = t.get("function")?;
                    Some(json!({
                        "name": func.get("name").cloned().unwrap_or(Value::Null),
                        "description": func.get("description").cloned().unwrap_or(Value::Null),
                        "input_schema": func.get("parameters").cloned().unwrap_or(json!({"type": "object"})),
                    }))
                })
                .collect();
            if !mapped.is_empty() {
                out["tools"] = json!(mapped);
                // Tools come first in Anthropic's prefix order, so one marker on
                // the last of them caches the whole array.
                if explicit {
                    if let Some(last) = out["tools"].as_array_mut().and_then(|t| t.last_mut()) {
                        last["cache_control"] = ephemeral_cache_marker();
                    }
                }
            }
        }
        if let Some(tc) = body.get("tool_choice") {
            // Forced tool use returns a 400 on these models; the prompt already
            // names the tool, so fall back to `auto`.
            let no_forced = anthropic_rejects_forced_tool_choice(model_id);
            out["tool_choice"] = match tc.as_str() {
                Some("none") => json!({"type": "none"}),
                Some("auto") => json!({"type": "auto"}),
                _ if no_forced => json!({"type": "auto"}),
                Some("required") => json!({"type": "any"}),
                _ => {
                    // {"type":"function","function":{"name":...}} -> {"type":"tool","name":...}
                    match tc.get("function").and_then(|f| f.get("name")) {
                        Some(name) => json!({"type": "tool", "name": name}),
                        None => json!({"type": "auto"}),
                    }
                }
            };
        }
        if body.get("parallel_tool_calls") == Some(&json!(false)) && out.get("tools").is_some() {
            match out.get_mut("tool_choice") {
                Some(t) if t.get("type").and_then(|x| x.as_str()) == Some("none") => {}
                Some(t) => t["disable_parallel_tool_use"] = json!(true),
                None => {
                    out["tool_choice"] = json!({"type": "auto", "disable_parallel_tool_use": true});
                }
            }
        }

        out
    }

    fn convert_response(&self, upstream: &Value) -> Value {
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();

        if let Some(blocks) = upstream.get("content").and_then(|c| c.as_array()) {
            for block in blocks {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                            content.push_str(t);
                        }
                    }
                    Some("thinking") => {
                        if let Some(t) = block.get("thinking").and_then(|t| t.as_str()) {
                            reasoning.push_str(t);
                        }
                    }
                    Some("tool_use") => {
                        let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                        tool_calls.push(json!({
                            "id": block.get("id").cloned().unwrap_or(Value::Null),
                            "type": "function",
                            "function": {
                                "name": block.get("name").cloned().unwrap_or(Value::Null),
                                "arguments": serde_json::to_string(&input).unwrap_or_default(),
                            }
                        }));
                    }
                    _ => {}
                }
            }
        }

        let mut message = json!({"role": "assistant"});
        let saw_tool = !tool_calls.is_empty();
        message["content"] = if content.is_empty() && saw_tool {
            Value::Null
        } else {
            json!(content)
        };
        if !reasoning.is_empty() {
            message["reasoning_content"] = json!(reasoning);
        }
        if saw_tool {
            message["tool_calls"] = json!(tool_calls);
        }
        let finish_reason = map_anthropic_finish(
            upstream
                .get("stop_reason")
                .and_then(|r| r.as_str())
                .unwrap_or("end_turn"),
            saw_tool,
        );
        let usage = upstream.get("usage");
        let input_tokens = usage
            .and_then(|u| u.get("input_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let output_tokens = usage
            .and_then(|u| u.get("output_tokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let (cache_read, cache_creation) = anthropic_cache_counts(usage);

        json!({
            "id": upstream.get("id").cloned().unwrap_or_else(|| json!("chatcmpl-proxy")),
            "object": "chat.completion",
            "created": 0,
            "model": upstream.get("model").cloned().unwrap_or(Value::Null),
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }],
            "usage": anthropic_usage(input_tokens, output_tokens, cache_read, cache_creation),
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
            "message_start" => {
                if let Some(msg) = data.get("message") {
                    if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                        state.id = id.to_string();
                    }
                    if let Some(model) = msg.get("model").and_then(|v| v.as_str()) {
                        state.model = model.to_string();
                    }
                    if let Some(t) = msg
                        .get("usage")
                        .and_then(|u| u.get("input_tokens"))
                        .and_then(|v| v.as_i64())
                    {
                        state.input_tokens = t;
                    }
                    let (read, creation) = anthropic_cache_counts(msg.get("usage"));
                    state.cache_read_input_tokens = read;
                    state.cache_creation_input_tokens = creation;
                }
            }
            "content_block_start" => {
                let block = data.get("content_block");
                let block_type = block.and_then(|b| b.get("type")).and_then(|t| t.as_str());
                push_role_chunk(state, &mut out);
                if block_type == Some("tool_use") {
                    let block_index = data
                        .get("index")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0)
                        .to_string();
                    let idx = state.next_tool_index;
                    state.next_tool_index += 1;
                    state.tool_index.insert(block_index, idx);
                    state.saw_tool_call = true;
                    out.push(chunk_str(
                        state,
                        json!({"tool_calls": [{
                            "index": idx,
                            "id": block.and_then(|b| b.get("id")).cloned().unwrap_or(Value::Null),
                            "type": "function",
                            "function": {
                                "name": block.and_then(|b| b.get("name")).cloned().unwrap_or(Value::Null),
                                "arguments": "",
                            }
                        }]}),
                        None,
                    ));
                }
            }
            "content_block_delta" => {
                let delta = data.get("delta");
                match delta.and_then(|d| d.get("type")).and_then(|t| t.as_str()) {
                    Some("text_delta") => {
                        if let Some(text) =
                            delta.and_then(|d| d.get("text")).and_then(|t| t.as_str())
                        {
                            push_role_chunk(state, &mut out);
                            out.push(chunk_str(state, json!({"content": text}), None));
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta
                            .and_then(|d| d.get("thinking"))
                            .and_then(|t| t.as_str())
                        {
                            push_role_chunk(state, &mut out);
                            out.push(chunk_str(state, json!({"reasoning_content": text}), None));
                        }
                    }
                    Some("input_json_delta") => {
                        let block_index = data
                            .get("index")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0)
                            .to_string();
                        let Some(&idx) = state.tool_index.get(&block_index) else {
                            log::warn!("anthropic stream: input delta for unknown block {block_index} dropped");
                            return out;
                        };
                        if let Some(partial) = delta
                            .and_then(|d| d.get("partial_json"))
                            .and_then(|t| t.as_str())
                        {
                            out.push(chunk_str(
                                state,
                                json!({"tool_calls": [{"index": idx, "function": {"arguments": partial}}]}),
                                None,
                            ));
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                // Carries the terminal stop_reason + cumulative output tokens.
                let reason = data
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("end_turn");
                let finish = map_anthropic_finish(reason, state.saw_tool_call);
                let delta_usage = data.get("usage");
                let output_tokens = delta_usage
                    .and_then(|u| u.get("output_tokens"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                // `message_delta` usage is cumulative: a value here replaces
                // the `message_start` one rather than adding to it.
                if let Some(t) = delta_usage
                    .and_then(|u| u.get("input_tokens"))
                    .and_then(|v| v.as_i64())
                {
                    state.input_tokens = t;
                }
                let (read, creation) = anthropic_cache_counts(delta_usage);
                if read.is_some() {
                    state.cache_read_input_tokens = read;
                }
                if creation.is_some() {
                    state.cache_creation_input_tokens = creation;
                }
                let usage = anthropic_usage(
                    state.input_tokens,
                    output_tokens,
                    state.cache_read_input_tokens,
                    state.cache_creation_input_tokens,
                );
                out.push(chunk_str_with_usage(
                    state,
                    json!({}),
                    Some(finish),
                    Some(&usage),
                ));
                out.push("[DONE]".to_string());
                state.finished = true;
            }
            // `event: error` (overloaded_error, api_error, ...) mid-stream:
            // surface it instead of ending as a truncated success (#184).
            "error" => {
                let message = data
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("upstream error");
                return stream_error(state, message);
            }
            _ => {}
        }
        out
    }
}

/// The chat/completions-shaped error payload a converter emits when the
/// provider fails mid-stream, followed by `[DONE]`, the same shape the
/// Responses converter uses for `response.failed`.
fn stream_error(state: &mut StreamState, message: &str) -> Vec<String> {
    state.finished = true;
    vec![
        json!({"error": {"message": message}}).to_string(),
        "[DONE]".to_string(),
    ]
}

/// The error a Gemini stream chunk reports, if any: a top-level `error`
/// object, or a prompt blocked before any candidate was produced.
/// Gemini returns no call ids, so ids are invented. A random prefix per
/// response keeps them unique across turns of one history.
fn new_gemini_call_prefix() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

fn gemini_stream_error(data: &Value) -> Option<String> {
    if let Some(error) = data.get("error") {
        let message = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("upstream error");
        return Some(message.to_string());
    }
    let no_candidates = data
        .get("candidates")
        .and_then(|c| c.as_array())
        .is_none_or(|c| c.is_empty());
    let block = data
        .get("promptFeedback")
        .and_then(|f| f.get("blockReason"))
        .and_then(|r| r.as_str());
    match block {
        Some(reason) if no_candidates => Some(format!("the prompt was blocked: {reason}")),
        _ => None,
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

/// Build a finish chunk. `usage` is already chat-shaped (`prompt_tokens` etc.).
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
        chunk["usage"] = u.clone();
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
    let mut out = json!({
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
    });
    // Responses already counts cached tokens inside `input_tokens`, exactly as
    // chat/completions does inside `prompt_tokens`; only the name moves.
    if let Some(cached) = u
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_i64())
    {
        out["prompt_tokens_details"] = json!({ "cached_tokens": cached });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_split_across_chunks_is_not_corrupted() {
        let payload = "{\"t\":\"h\u{e9}llo \u{4e16}\u{754c} \u{1F600}\"}";
        let body = format!("data: {payload}\n\n");
        let body = body.as_bytes();
        // Every split point, including inside each multi-byte character.
        for cut in 1..body.len() {
            let mut acc = SseAccumulator::new();
            let mut events = acc.push_bytes(&body[..cut]);
            events.extend(acc.push_bytes(&body[cut..]));
            assert_eq!(events.len(), 1, "cut at {cut}");
            assert_eq!(events[0].data, payload, "cut at {cut}");
        }
    }

    #[test]
    fn utf8_decoder_holds_back_only_an_incomplete_tail() {
        let mut d = Utf8ChunkDecoder::default();
        let euro = "\u{20ac}".as_bytes(); // 3 bytes
        assert_eq!(d.push(&euro[..2]), "");
        assert_eq!(d.push(&euro[2..]), "\u{20ac}");
        // Invalid bytes are still replaced, not held forever.
        assert_eq!(d.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        assert_eq!(d.push(&[0xE2]), "");
        assert_eq!(d.finish(), "\u{FFFD}");
    }

    #[test]
    fn message_images_reads_inline_and_remote_images_and_skips_the_rest() {
        let content = json!([
            {"type": "text", "text": "a"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            {"type": "image_url", "image_url": {"url": "https://x.test/a.jpg"}},
            {"type": "image_url", "image_url": {"url": "data:image/png,notbase64"}},
            {"type": "image_url"},
            {"type": "input_audio"}
        ]);
        assert_eq!(
            message_images(&content),
            vec![
                ImageSource::Base64 { mime: "image/png", data: "AAAA" },
                ImageSource::Url("https://x.test/a.jpg"),
            ]
        );
        assert!(message_images(&json!("plain")).is_empty());
    }

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
    fn response_carries_the_cached_input_count_and_omits_it_when_absent() {
        let with_cache = convert_usage(Some(&json!({
            "input_tokens": 2006, "output_tokens": 300, "total_tokens": 2306,
            "input_tokens_details": {"cached_tokens": 1920}
        })));
        assert_eq!(with_cache["prompt_tokens"], json!(2006));
        assert_eq!(
            with_cache["prompt_tokens_details"],
            json!({"cached_tokens": 1920})
        );

        let without = convert_usage(Some(&json!({"input_tokens": 3, "output_tokens": 4})));
        assert!(without.get("prompt_tokens_details").is_none());
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
        assert_eq!(
            out["reasoning"],
            json!({"effort": "high", "summary": "auto"})
        );
    }

    /// A camera frame from a tool, and a pasted image from the user, both
    /// reach Responses in its own item forms; text-only content is unchanged.
    #[test]
    fn request_carries_tool_and_user_images() {
        let body = json!({
            "model": "gpt-5",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "what is this"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}}
                ]},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "cam", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": [
                    {"type": "text", "text": "front camera"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]}
            ]
        });
        let input = conv().convert_request(&body)["input"].clone();
        assert_eq!(
            input[0]["content"],
            json!([
                {"type": "input_text", "text": "what is this"},
                {"type": "input_image", "image_url": "data:image/png;base64,BBBB"}
            ])
        );
        assert_eq!(
            input[2]["output"],
            json!([
                {"type": "input_text", "text": "front camera"},
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
            ])
        );
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
        assert_eq!(
            out["usage"],
            json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
        );
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
                &ev(
                    "response.created",
                    json!({"response": {"id": "r1", "model": "gpt-5", "created_at": 9}})
                ),
                &mut state
            )
            .is_empty());
        let first = c.convert_stream_event(
            &ev("response.output_text.delta", json!({"delta": "he"})),
            &mut state,
        );
        assert_eq!(first.len(), 2);
        let role: Value = serde_json::from_str(&first[0]).unwrap();
        assert_eq!(role["choices"][0]["delta"]["role"], json!("assistant"));
        assert_eq!(role["id"], json!("r1"));
        assert_eq!(role["model"], json!("gpt-5"));
        let content: Value = serde_json::from_str(&first[1]).unwrap();
        assert_eq!(content["choices"][0]["delta"]["content"], json!("he"));

        let second = c.convert_stream_event(
            &ev("response.output_text.delta", json!({"delta": "llo"})),
            &mut state,
        );
        assert_eq!(second.len(), 1);
        let content2: Value = serde_json::from_str(&second[0]).unwrap();
        assert_eq!(content2["choices"][0]["delta"]["content"], json!("llo"));
    }

    #[test]
    fn stream_reasoning_delta_maps_to_reasoning_content() {
        let c = conv();
        let mut state = StreamState::default();
        let out = c.convert_stream_event(
            &ev(
                "response.reasoning_summary_text.delta",
                json!({"delta": "hmm"}),
            ),
            &mut state,
        );
        // role chunk + reasoning chunk
        assert_eq!(out.len(), 2);
        let reasoning: Value = serde_json::from_str(&out[1]).unwrap();
        assert_eq!(
            reasoning["choices"][0]["delta"]["reasoning_content"],
            json!("hmm")
        );
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
            &ev(
                "response.function_call_arguments.delta",
                json!({"item_id": "fc_1", "delta": "{\"x\""}),
            ),
            &mut state,
        );
        assert_eq!(arg.len(), 1);
        let arg_chunk: Value = serde_json::from_str(&arg[0]).unwrap();
        let atc = &arg_chunk["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(atc["index"], json!(0));
        assert_eq!(atc["function"]["arguments"], json!("{\"x\""));
    }

    #[test]
    fn responses_incomplete_max_tokens_is_length() {
        let upstream = json!({
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [{"type": "function_call", "call_id": "c1", "name": "f", "arguments": "{\"a\""}]
        });
        let out = conv().convert_response(&upstream);
        assert_eq!(out["choices"][0]["finish_reason"], json!("length"));
    }

    #[test]
    fn responses_stream_incomplete_content_filter() {
        let c = conv();
        let mut state = StreamState::default();
        let out = c.convert_stream_event(
            &ev(
                "response.incomplete",
                json!({"response": {"status": "incomplete", "incomplete_details": {"reason": "content_filter"}}}),
            ),
            &mut state,
        );
        let finish: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(finish["choices"][0]["finish_reason"], json!("content_filter"));
    }

    #[test]
    fn responses_tool_choice_flattened() {
        let body = json!({
            "model": "m", "messages": [],
            "tool_choice": {"type": "function", "function": {"name": "pick"}}
        });
        let out = conv().convert_request(&body);
        assert_eq!(out["tool_choice"], json!({"type": "function", "name": "pick"}));
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
            .convert_stream_event(
                &ev("response.output_text.delta", json!({"delta": "x"})),
                &mut state
            )
            .is_empty());
    }

    #[test]
    fn stream_dispatches_on_data_type_when_event_field_absent() {
        let c = conv();
        let mut state = StreamState::default();
        let out = c.convert_stream_event(
            &ev(
                "",
                json!({"type": "response.output_text.delta", "delta": "hi"}),
            ),
            &mut state,
        );
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn stream_ignores_done_sentinel_and_bad_json() {
        let c = conv();
        let mut state = StreamState::default();
        assert!(c
            .convert_stream_event(
                &SseEvent {
                    event: String::new(),
                    data: "[DONE]".into()
                },
                &mut state
            )
            .is_empty());
        assert!(c
            .convert_stream_event(
                &SseEvent {
                    event: String::new(),
                    data: "not json".into()
                },
                &mut state
            )
            .is_empty());
    }
}

#[cfg(test)]
mod google_generate_content_tests {
    use super::*;

    fn conv() -> GoogleGenerateContentConverter {
        GoogleGenerateContentConverter::new()
    }

    #[test]
    fn usage_carries_cached_content_and_omits_it_when_absent() {
        let with_cache = convert_gemini_usage(Some(&json!({
            "promptTokenCount": 900, "candidatesTokenCount": 10,
            "cachedContentTokenCount": 800, "totalTokenCount": 910
        })));
        assert_eq!(with_cache["prompt_tokens"], json!(900));
        assert_eq!(with_cache["prompt_tokens_details"], json!({"cached_tokens": 800}));

        let without = convert_gemini_usage(Some(&json!({
            "promptTokenCount": 3, "candidatesTokenCount": 2, "totalTokenCount": 5
        })));
        assert!(without.get("prompt_tokens_details").is_none());
    }

    #[test]
    fn path_escapes_a_hostile_model_name() {
        let c = conv();
        let path = c.upstream_path(&json!({"model": "../x?key=1"}));
        assert_eq!(path, "/models/..%2Fx%3Fkey%3D1:generateContent");
        assert_eq!(c.upstream_path(&json!({"model": ".."})), "/models/%2E%2E:generateContent");
        assert_eq!(
            c.upstream_path(&json!({"model": "models/gemini-2.5-pro"})),
            "/models/gemini-2.5-pro:generateContent"
        );
    }

    #[test]
    fn path_encodes_model_and_action() {
        let c = conv();
        assert_eq!(
            c.upstream_path(&json!({"model": "gemini-2.5-pro"})),
            "/models/gemini-2.5-pro:generateContent"
        );
        assert_eq!(
            c.upstream_path(&json!({"model": "gemini-2.5-pro", "stream": true})),
            "/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn auth_uses_goog_api_key() {
        assert_eq!(conv().auth_header("k"), ("x-goog-api-key", "k".to_string()));
    }

    #[test]
    fn request_maps_roles_system_and_thinking() {
        let body = json!({
            "model": "gemini-2.5-pro",
            "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"}
            ],
            "temperature": 0.5,
            "top_p": 0.9,
            "max_tokens": 100,
            "reasoning_effort": "high"
        });
        let out = conv().convert_request(&body);
        assert_eq!(
            out["systemInstruction"],
            json!({"parts": [{"text": "be brief"}]})
        );
        assert_eq!(
            out["contents"],
            json!([
                {"role": "user", "parts": [{"text": "hi"}]},
                {"role": "model", "parts": [{"text": "hello"}]}
            ])
        );
        assert_eq!(out["generationConfig"]["temperature"], json!(0.5));
        assert_eq!(out["generationConfig"]["topP"], json!(0.9));
        assert_eq!(out["generationConfig"]["maxOutputTokens"], json!(100));
        assert_eq!(
            out["generationConfig"]["thinkingConfig"],
            json!({"thinkingBudget": -1, "includeThoughts": true})
        );
    }

    #[test]
    fn low_and_none_effort_do_not_force_dynamic_thinking() {
        let req = |effort: &str| {
            conv().convert_request(&json!({
                "model": "gemini-2.5-flash",
                "messages": [{"role": "user", "content": "hi"}],
                "reasoning_effort": effort
            }))
        };
        assert!(req("none")["generationConfig"].get("thinkingConfig").is_none());
        for low in ["minimal", "low"] {
            assert_eq!(
                req(low)["generationConfig"]["thinkingConfig"]["thinkingBudget"],
                json!(1024)
            );
        }
        assert_eq!(
            req("medium")["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            json!(-1)
        );
    }

    #[test]
    fn request_maps_tool_calls_and_results() {
        let body = json!({
            "model": "gemini-2.5-pro",
            "messages": [
                {"role": "user", "content": "weather?"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "getw", "arguments": "{\"city\":\"NYC\"}"}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "{\"temp\":20}"}
            ],
            "tools": [
                {"type": "function", "function": {"name": "getw", "description": "d", "parameters": {"type": "object"}}}
            ],
            "tool_choice": "required"
        });
        let out = conv().convert_request(&body);
        let contents = out["contents"].as_array().unwrap();
        assert_eq!(
            contents[1],
            json!({"role": "model", "parts": [{"functionCall": {"name": "getw", "args": {"city": "NYC"}}}]})
        );
        assert_eq!(
            contents[2],
            json!({"role": "user", "parts": [{"functionResponse": {"name": "getw", "response": {"temp": 20}}}]})
        );
        assert_eq!(
            out["tools"],
            json!([{"functionDeclarations": [{"name": "getw", "description": "d", "parameters": {"type": "object"}}]}])
        );
        assert_eq!(
            out["toolConfig"],
            json!({"functionCallingConfig": {"mode": "ANY"}})
        );
    }

    fn image_tool_body(model: &str) -> Value {
        json!({
            "model": model,
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "what is this"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}}
                ]},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "cam", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "c1", "content": [
                    {"type": "text", "text": "front camera"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]}
            ]
        })
    }

    #[test]
    fn a_user_image_becomes_inline_data() {
        let out = conv().convert_request(&image_tool_body("gemini-2.5-pro"));
        assert_eq!(
            out["contents"][0]["parts"],
            json!([
                {"text": "what is this"},
                {"inlineData": {"mimeType": "image/png", "data": "BBBB"}}
            ])
        );
    }

    /// Gemini 3 reads a tool's media nested in its `functionResponse`.
    #[test]
    fn a_gemini_3_tool_image_nests_in_the_function_response() {
        let out = conv().convert_request(&image_tool_body("models/gemini-3-flash-preview"));
        let parts = out["contents"][2]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 1, "{parts:?}");
        assert_eq!(parts[0]["functionResponse"]["name"], json!("cam"));
        assert_eq!(parts[0]["functionResponse"]["response"], json!({"result": "front camera"}));
        assert_eq!(
            parts[0]["functionResponse"]["parts"],
            json!([{"inlineData": {"mimeType": "image/png", "data": "AAAA"}}])
        );
    }

    /// Earlier models ignore nested parts, so the image rides beside the
    /// response in the same turn.
    #[test]
    fn an_older_gemini_tool_image_is_a_sibling_part() {
        let out = conv().convert_request(&image_tool_body("gemini-2.5-pro"));
        let parts = out["contents"][2]["parts"].as_array().unwrap();
        assert!(parts[0]["functionResponse"].get("parts").is_none(), "{parts:?}");
        assert_eq!(parts[1], json!({"inlineData": {"mimeType": "image/png", "data": "AAAA"}}));
    }

    #[test]
    fn gemini_generation_is_read_from_the_model_name() {
        let reads = |m: &str| gemini_reads_function_response_parts(&json!({"model": m}));
        assert!(reads("gemini-3-pro"));
        assert!(reads("gemini-3.1-flash"));
        assert!(reads("models/gemini-3.8-flash"));
        assert!(!reads("gemini-2.5-pro"));
        assert!(!reads("gemini-1.5-flash"));
        assert!(!reads("gemma-3-27b"));
        assert!(!reads("some-alias"));
    }

    #[test]
    fn tool_result_wraps_non_json_content() {
        let body = json!({
            "model": "g",
            "messages": [{"role": "tool", "tool_call_id": "x", "content": "plain text"}]
        });
        let out = conv().convert_request(&body);
        assert_eq!(
            out["contents"][0]["parts"][0]["functionResponse"]["response"],
            json!({"result": "plain text"})
        );
    }

    #[test]
    fn response_maps_text_thought_and_usage() {
        let upstream = json!({
            "responseId": "r1",
            "modelVersion": "gemini-2.5-pro",
            "candidates": [{
                "content": {"role": "model", "parts": [
                    {"text": "thinking...", "thought": true},
                    {"text": "answer"}
                ]},
                "finishReason": "STOP"
            }],
            "usageMetadata": {"promptTokenCount": 8, "candidatesTokenCount": 4, "thoughtsTokenCount": 2, "totalTokenCount": 14}
        });
        let out = conv().convert_response(&upstream);
        let choice = &out["choices"][0];
        assert_eq!(choice["message"]["content"], json!("answer"));
        assert_eq!(choice["message"]["reasoning_content"], json!("thinking..."));
        assert_eq!(choice["finish_reason"], json!("stop"));
        assert_eq!(out["id"], json!("r1"));
        assert_eq!(out["model"], json!("gemini-2.5-pro"));
        assert_eq!(
            out["usage"],
            json!({"prompt_tokens": 8, "completion_tokens": 6, "total_tokens": 14})
        );
    }

    #[test]
    fn gemini_ids_unique_across_turns() {
        let upstream = json!({"candidates": [{
            "content": {"parts": [{"functionCall": {"name": "a", "args": {}}}]},
            "finishReason": "STOP"
        }]});
        let c = conv();
        let one = c.convert_response(&upstream);
        let two = c.convert_response(&upstream);
        assert_ne!(
            one["choices"][0]["message"]["tool_calls"][0]["id"],
            two["choices"][0]["message"]["tool_calls"][0]["id"]
        );
        let mut state = StreamState::default();
        let event = ev(json!({"candidates": [{"content": {"parts": [
            {"functionCall": {"name": "a", "args": {}}},
            {"functionCall": {"name": "b", "args": {}}}
        ]}}]}));
        let out = c.convert_stream_event(&event, &mut state);
        let ids: Vec<String> = out
            .iter()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter_map(|v| {
                v["choices"][0]["delta"]["tool_calls"][0]["id"]
                    .as_str()
                    .map(String::from)
            })
            .collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
        assert_eq!(ids[0].rsplit_once('_').unwrap().0, ids[1].rsplit_once('_').unwrap().0);
    }

    #[test]
    fn gemini_two_turns_both_call_0_resolve_names_positionally() {
        let body = json!({
            "model": "g",
            "messages": [
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "call_0", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "call_0", "content": "{\"a\":1}"},
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "call_0", "type": "function", "function": {"name": "bash", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "call_0", "content": "{\"b\":2}"}
            ]
        });
        let out = conv().convert_request(&body);
        let c = out["contents"].as_array().unwrap();
        assert_eq!(c[1]["parts"][0]["functionResponse"]["name"], json!("read_file"));
        assert_eq!(c[3]["parts"][0]["functionResponse"]["name"], json!("bash"));
    }

    #[test]
    fn gemini_parallel_tool_results_merge_into_one_user_content() {
        let body = json!({
            "model": "g",
            "messages": [
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "x1", "type": "function", "function": {"name": "a", "arguments": "{}"}},
                    {"id": "x2", "type": "function", "function": {"name": "b", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "x1", "content": "{}"},
                {"role": "tool", "tool_call_id": "x2", "content": "{}"},
                {"role": "user", "content": "thanks"}
            ]
        });
        let out = conv().convert_request(&body);
        let c = out["contents"].as_array().unwrap();
        assert_eq!(c.len(), 3, "{c:?}");
        let parts = c[1]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["functionResponse"]["name"], json!("a"));
        assert_eq!(parts[1]["functionResponse"]["name"], json!("b"));
        // The plain-text user message stays its own content.
        assert_eq!(c[2]["parts"][0]["text"], json!("thanks"));
    }

    #[test]
    fn gemini_nonstream_blocked_prompt_returns_error() {
        let out = conv().convert_response(&json!({"promptFeedback": {"blockReason": "SAFETY"}}));
        assert!(out["error"]["message"].as_str().unwrap().contains("SAFETY"));
        assert!(out.get("choices").is_none());
        let safety = conv().convert_response(&json!({"candidates": [{"finishReason": "SAFETY"}]}));
        assert_eq!(safety["choices"][0]["finish_reason"], json!("content_filter"));
        assert!(!safety["choices"][0]["message"]["content"].as_str().unwrap().is_empty());
    }

    #[test]
    fn gemini_max_tokens_with_tool_call_is_length() {
        let upstream = json!({
            "candidates": [{
                "content": {"parts": [{"functionCall": {"name": "getw", "args": {}}}]},
                "finishReason": "MAX_TOKENS"
            }]
        });
        let out = conv().convert_response(&upstream);
        assert_eq!(out["choices"][0]["finish_reason"], json!("length"));
    }

    #[test]
    fn response_maps_function_call() {
        let upstream = json!({
            "candidates": [{
                "content": {"parts": [{"functionCall": {"name": "getw", "args": {"city": "NYC"}}}]},
                "finishReason": "STOP"
            }]
        });
        let out = conv().convert_response(&upstream);
        let choice = &out["choices"][0];
        assert_eq!(choice["finish_reason"], json!("tool_calls"));
        assert_eq!(choice["message"]["content"], Value::Null);
        let tc = &choice["message"]["tool_calls"][0];
        assert!(tc["id"].as_str().unwrap().starts_with("call_"));
        assert!(tc["id"].as_str().unwrap().ends_with("_0"));
        assert_eq!(tc["function"]["name"], json!("getw"));
        assert_eq!(tc["function"]["arguments"], json!("{\"city\":\"NYC\"}"));
    }

    fn ev(data: Value) -> SseEvent {
        SseEvent {
            event: String::new(),
            data: data.to_string(),
        }
    }

    #[test]
    fn a_mid_stream_error_or_blocked_prompt_is_an_error_not_a_success() {
        let c = conv();
        let mut state = StreamState::default();
        c.convert_stream_event(
            &ev(json!({"candidates": [{"content": {"parts": [{"text": "par"}]}}]})),
            &mut state,
        );
        let out = c.convert_stream_event(
            &ev(json!({"error": {"code": 503, "message": "The model is overloaded."}})),
            &mut state,
        );
        assert_eq!(out.len(), 2);
        let err: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(err["error"]["message"], "The model is overloaded.");
        assert_eq!(out[1], "[DONE]");
        assert!(state.finished);

        let mut state = StreamState::default();
        let out = c.convert_stream_event(
            &ev(json!({"promptFeedback": {"blockReason": "SAFETY"}})),
            &mut state,
        );
        let err: Value = serde_json::from_str(&out[0]).unwrap();
        assert!(err["error"]["message"].as_str().unwrap().contains("SAFETY"));
    }

    #[test]
    fn stream_emits_role_reasoning_content_and_finish() {
        let c = conv();
        let mut state = StreamState::default();
        let first = c.convert_stream_event(
            &ev(json!({
                "modelVersion": "gemini-2.5-pro",
                "candidates": [{"content": {"parts": [{"text": "hmm", "thought": true}]}}]
            })),
            &mut state,
        );
        assert_eq!(first.len(), 2);
        let role: Value = serde_json::from_str(&first[0]).unwrap();
        assert_eq!(role["choices"][0]["delta"]["role"], json!("assistant"));
        assert_eq!(role["model"], json!("gemini-2.5-pro"));
        let reason: Value = serde_json::from_str(&first[1]).unwrap();
        assert_eq!(
            reason["choices"][0]["delta"]["reasoning_content"],
            json!("hmm")
        );

        let second = c.convert_stream_event(
            &ev(json!({"candidates": [{"content": {"parts": [{"text": "hello"}]}}]})),
            &mut state,
        );
        assert_eq!(second.len(), 1);
        let content: Value = serde_json::from_str(&second[0]).unwrap();
        assert_eq!(content["choices"][0]["delta"]["content"], json!("hello"));

        let last = c.convert_stream_event(
            &ev(json!({
                "candidates": [{"finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 2, "totalTokenCount": 5}
            })),
            &mut state,
        );
        assert_eq!(last.len(), 2);
        let finish: Value = serde_json::from_str(&last[0]).unwrap();
        assert_eq!(finish["choices"][0]["finish_reason"], json!("stop"));
        assert_eq!(finish["usage"]["prompt_tokens"], json!(3));
        assert_eq!(last[1], "[DONE]");
        assert!(state.finished);
    }

    #[test]
    fn stream_function_call_emits_full_tool_call() {
        let c = conv();
        let mut state = StreamState::default();
        let out = c.convert_stream_event(
            &ev(json!({
                "candidates": [{
                    "content": {"parts": [{"functionCall": {"name": "getw", "args": {"x": 1}}}]},
                    "finishReason": "STOP"
                }]
            })),
            &mut state,
        );
        // role chunk + tool_calls chunk + finish + [DONE]
        assert_eq!(out.len(), 4);
        let tool: Value = serde_json::from_str(&out[1]).unwrap();
        let tc = &tool["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(tc["index"], json!(0));
        assert!(tc["id"].as_str().unwrap().starts_with("call_"));
        assert!(tc["id"].as_str().unwrap().ends_with("_0"));
        assert_eq!(tc["function"]["name"], json!("getw"));
        assert_eq!(tc["function"]["arguments"], json!("{\"x\":1}"));
        let finish: Value = serde_json::from_str(&out[2]).unwrap();
        assert_eq!(finish["choices"][0]["finish_reason"], json!("tool_calls"));
        assert_eq!(out[3], "[DONE]");
    }
}

#[cfg(test)]
mod anthropic_messages_tests {
    use super::*;

    fn conv() -> AnthropicMessagesConverter {
        AnthropicMessagesConverter::new()
    }

    fn cache_ev(event: &str, data: Value) -> SseEvent {
        SseEvent {
            event: event.to_string(),
            data: data.to_string(),
        }
    }

    // Anthropic's `input_tokens` excludes both cache counts; chat/completions'
    // `prompt_tokens` includes them. The creation count is part of that total
    // and must not be added twice.
    #[test]
    fn response_folds_anthropic_cache_counts_into_the_prompt_total() {
        let upstream = json!({
            "id": "msg_1",
            "model": "claude-sonnet-4",
            "content": [{"type": "text", "text": "hi"}],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 12,
                "cache_read_input_tokens": 2000,
                "cache_creation_input_tokens": 300,
                "output_tokens": 6
            }
        });
        let out = conv().convert_response(&upstream);
        assert_eq!(
            out["usage"],
            json!({
                "prompt_tokens": 2312,
                "completion_tokens": 6,
                "total_tokens": 2318,
                "prompt_tokens_details": {"cached_tokens": 2000},
                "cache_creation_input_tokens": 300
            })
        );
    }

    #[test]
    fn response_without_cache_counts_reports_none_rather_than_zero() {
        let upstream = json!({
            "content": [{"type": "text", "text": "hi"}],
            "usage": {"input_tokens": 12, "output_tokens": 6}
        });
        let out = conv().convert_response(&upstream);
        assert!(out["usage"].get("prompt_tokens_details").is_none());
        assert!(out["usage"].get("cache_creation_input_tokens").is_none());
    }

    #[test]
    fn stream_keeps_the_final_cumulative_cache_counts_without_summing() {
        let c = conv();
        let mut state = StreamState::default();
        c.convert_stream_event(
            &cache_ev(
                "message_start",
                json!({"message": {"id": "m", "model": "c", "usage": {
                    "input_tokens": 10,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 50,
                    "output_tokens": 1
                }}}),
            ),
            &mut state,
        );
        // The delta restates the cumulative totals; they replace, not add.
        let done = c.convert_stream_event(
            &cache_ev(
                "message_delta",
                json!({"delta": {"stop_reason": "end_turn"}, "usage": {
                    "output_tokens": 7,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 50
                }}),
            ),
            &mut state,
        );
        let finish: Value = serde_json::from_str(&done[0]).unwrap();
        assert_eq!(
            finish["usage"],
            json!({
                "prompt_tokens": 160,
                "completion_tokens": 7,
                "total_tokens": 167,
                "prompt_tokens_details": {"cached_tokens": 100},
                "cache_creation_input_tokens": 50
            })
        );
    }

    #[test]
    fn converter_for_uses_the_api_key_scheme_and_passes_unknown_through() {
        let c = converter_for(Some("anthropic")).expect("anthropic converter");
        assert_eq!(c.auth_header("k"), ("x-api-key", "k".to_string()));
        assert_eq!(c.extra_headers(), vec![("anthropic-version", "2023-06-01")]);
        assert_eq!(c.upstream_path(&json!({})), "/messages");
        let r = converter_for(Some("openai-responses")).expect("responses converter");
        assert_eq!(r.upstream_path(&json!({})), "/responses");
        assert!(converter_for(Some("openai")).is_none());
        assert!(converter_for(None).is_none());
    }

    #[test]
    fn request_maps_system_messages_and_default_max_tokens() {
        let body = json!({
            "model": "claude-sonnet-4",
            "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "hi"}
            ]
        });
        let out = conv().convert_request(&body);
        assert_eq!(out["model"], json!("claude-sonnet-4"));
        // Anthropic is an explicit-cache route, so the prompt is a text block
        // that carries the breakpoint rather than a bare string.
        assert_eq!(
            out["system"],
            json!([{"type": "text", "text": "be brief", "cache_control": {"type": "ephemeral"}}])
        );
        assert_eq!(out["max_tokens"], json!(ANTHROPIC_DEFAULT_MAX_TOKENS));
        assert_eq!(
            out["messages"],
            json!([{"role": "user", "content": [{"type": "text", "text": "hi"}]}])
        );
    }

    /// The reviewer's probe, inverted: a tool's image lands inside its
    /// `tool_result`, a user image as an `image` block, and the tool and user
    /// turns still coalesce into one user message.
    #[test]
    fn request_carries_tool_and_user_images() {
        let body = json!({
            "model": "claude-sonnet-4",
            "messages": [
                {"role": "user", "content": "go"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "host__camera", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": [
                    {"type": "text", "text": "front camera"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]},
                {"role": "user", "content": [
                    {"type": "text", "text": "what is this"},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,BBBB"}}
                ]}
            ]
        });
        let msgs = conv().convert_request(&body)["messages"].clone();
        assert_eq!(msgs.as_array().unwrap().len(), 3, "{msgs}");
        assert_eq!(
            msgs[2]["content"],
            json!([
                {"type": "tool_result", "tool_use_id": "call_1", "content": [
                    {"type": "text", "text": "front camera"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
                ]},
                {"type": "text", "text": "what is this"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "BBBB"}}
            ])
        );
    }

    #[test]
    fn a_remote_image_is_a_url_source() {
        let body = json!({
            "model": "claude-sonnet-4",
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "https://x.test/a.jpg"}}
            ]}]
        });
        let msgs = conv().convert_request(&body)["messages"].clone();
        assert_eq!(
            msgs[0]["content"],
            json!([{"type": "image", "source": {"type": "url", "url": "https://x.test/a.jpg"}}])
        );
    }

    #[test]
    fn request_merges_consecutive_tool_results_into_one_user_message() {
        let body = json!({
            "model": "claude-sonnet-4",
            "max_tokens": 256,
            "messages": [
                {"role": "user", "content": "go"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "a", "type": "function", "function": {"name": "f1", "arguments": "{\"x\":1}"}},
                    {"id": "b", "type": "function", "function": {"name": "f2", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "a", "content": "r1"},
                {"role": "tool", "tool_call_id": "b", "content": "r2"}
            ]
        });
        let out = conv().convert_request(&body);
        assert_eq!(out["max_tokens"], json!(256));
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["role"], json!("assistant"));
        assert_eq!(
            msgs[1]["content"],
            json!([
                {"type": "tool_use", "id": "a", "name": "f1", "input": {"x": 1}},
                {"type": "tool_use", "id": "b", "name": "f2", "input": {}}
            ])
        );
        // Both tool results merged into a single user message.
        assert_eq!(msgs[2]["role"], json!("user"));
        assert_eq!(
            msgs[2]["content"],
            json!([
                {"type": "tool_result", "tool_use_id": "a", "content": "r1"},
                {"type": "tool_result", "tool_use_id": "b", "content": "r2"}
            ])
        );
    }

    #[test]
    fn request_maps_tools_and_tool_choice() {
        let body = json!({
            "model": "c",
            "messages": [],
            "tools": [{"type": "function", "function": {"name": "f", "description": "d", "parameters": {"type": "object"}}}],
            "tool_choice": "required"
        });
        let out = conv().convert_request(&body);
        assert_eq!(
            out["tools"],
            json!([{
                "name": "f",
                "description": "d",
                "input_schema": {"type": "object"},
                "cache_control": {"type": "ephemeral"}
            }])
        );
        assert_eq!(out["tool_choice"], json!({"type": "any"}));
    }

    /// The breakpoints sit on the stable system head and on the last tool, and
    /// nowhere else: a later system message (an appended prompt update) is
    /// carried as plain text behind the cached head.
    #[test]
    fn explicit_route_marks_the_system_head_and_the_last_tool() {
        let body = json!({
            "model": "c",
            "messages": [
                {"role": "system", "content": "STABLE"},
                {"role": "system", "content": "UPDATE"},
                {"role": "user", "content": "hi"}
            ],
            "tools": [
                {"type": "function", "function": {"name": "a", "description": "d", "parameters": {"type": "object"}}},
                {"type": "function", "function": {"name": "b", "description": "d", "parameters": {"type": "object"}}}
            ]
        });
        let out = conv().convert_request(&body);
        assert_eq!(
            out["system"],
            json!([
                {"type": "text", "text": "STABLE", "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "UPDATE"}
            ])
        );
        let tools = out["tools"].as_array().unwrap();
        assert!(tools[0].get("cache_control").is_none());
        assert_eq!(tools[1]["cache_control"], json!({"type": "ephemeral"}));
        // Nothing in the conversation is marked.
        assert!(!out["messages"].to_string().contains("cache_control"));
    }

    /// The marker is a function of the declared capability, not of the
    /// provider: a route that is not explicit never receives the key a strict
    /// endpoint would reject.
    #[test]
    fn non_explicit_routes_never_receive_a_cache_marker() {
        let body = json!({
            "model": "c",
            "messages": [
                {"role": "system", "content": "STABLE"},
                {"role": "user", "content": "hi"}
            ],
            "tools": [{"type": "function", "function": {"name": "a", "description": "d", "parameters": {"type": "object"}}}]
        });
        for api_type in ["openai-responses", "google"] {
            let converter = converter_for(Some(api_type)).expect("converter");
            assert_ne!(converter.cache_capability(), CacheCapability::Explicit);
            let out = converter.convert_request(&body);
            assert!(
                !out.to_string().contains("cache_control"),
                "{api_type}: {out}"
            );
        }
    }

    #[test]
    fn capability_resolves_from_the_route_with_a_safe_default() {
        assert_eq!(CacheCapability::for_api_type(None), CacheCapability::Implicit);
        assert_eq!(
            CacheCapability::for_api_type(Some("openai")),
            CacheCapability::Implicit
        );
        assert_eq!(
            CacheCapability::for_api_type(Some("openai-responses")),
            CacheCapability::Implicit
        );
        assert_eq!(
            CacheCapability::for_api_type(Some("google")),
            CacheCapability::Implicit
        );
        assert_eq!(
            CacheCapability::for_api_type(Some("anthropic")),
            CacheCapability::Explicit
        );
        // An api_type nobody classified is not assumed to cache.
        assert_eq!(
            CacheCapability::for_api_type(Some("something-new")),
            CacheCapability::None
        );
    }

    /// A converter's own declaration and the route resolver cannot drift: both
    /// are asked about the same `api_type`.
    #[test]
    fn every_converter_declares_its_routes_capability() {
        for api_type in ["openai-responses", "google", "anthropic"] {
            let converter = converter_for(Some(api_type)).expect("converter");
            assert_eq!(
                converter.cache_capability(),
                CacheCapability::for_api_type(Some(api_type)),
                "{api_type}"
            );
        }
        assert_eq!(CacheCapability::Explicit.as_str(), "explicit");
    }

    #[test]
    fn request_maps_named_tool_choice() {
        let body = json!({
            "model": "c",
            "messages": [],
            "tool_choice": {"type": "function", "function": {"name": "pick"}}
        });
        let out = conv().convert_request(&body);
        assert_eq!(out["tool_choice"], json!({"type": "tool", "name": "pick"}));
    }

    #[test]
    fn request_drops_sampling_for_models_that_reject_it() {
        let body = json!({
            "model": "claude-opus-5-5",
            "messages": [],
            "temperature": 0.7,
            "top_p": 0.8,
            "stream": true
        });
        let out = conv().convert_request(&body);
        assert!(out.get("temperature").is_none());
        assert!(out.get("top_p").is_none());
        assert_eq!(out["stream"], json!(true));

        let older = json!({"model": "claude-sonnet-4-6", "messages": [], "temperature": 0.7});
        assert_eq!(conv().convert_request(&older)["temperature"], json!(0.7));
    }

    #[test]
    fn request_softens_forced_tool_choice_for_models_that_reject_it() {
        for tc in [json!("required"), json!({"type": "function", "function": {"name": "todo"}})] {
            let body = json!({"model": "claude-opus-5-5", "messages": [], "tool_choice": tc});
            assert_eq!(conv().convert_request(&body)["tool_choice"], json!({"type": "auto"}));
        }
    }

    #[test]
    fn anthropic_max_tokens_with_tool_use_is_length() {
        let upstream = json!({
            "id": "msg_1",
            "model": "claude-sonnet-4",
            "content": [{"type": "tool_use", "id": "tu_1", "name": "f", "input": {}}],
            "stop_reason": "max_tokens",
            "usage": {"input_tokens": 1, "output_tokens": 1}
        });
        let out = conv().convert_response(&upstream);
        assert_eq!(out["choices"][0]["finish_reason"], json!("length"));
    }

    #[test]
    fn response_maps_text_thinking_tool_use_and_usage() {
        let upstream = json!({
            "id": "msg_1",
            "model": "claude-sonnet-4",
            "content": [
                {"type": "thinking", "thinking": "hmm"},
                {"type": "text", "text": "hello"},
                {"type": "tool_use", "id": "tu_1", "name": "f", "input": {"a": 1}}
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 12, "output_tokens": 6}
        });
        let out = conv().convert_response(&upstream);
        let choice = &out["choices"][0];
        assert_eq!(choice["message"]["content"], json!("hello"));
        assert_eq!(choice["message"]["reasoning_content"], json!("hmm"));
        assert_eq!(choice["finish_reason"], json!("tool_calls"));
        let tc = &choice["message"]["tool_calls"][0];
        assert_eq!(tc["id"], json!("tu_1"));
        assert_eq!(tc["function"]["arguments"], json!("{\"a\":1}"));
        assert_eq!(
            out["usage"],
            json!({"prompt_tokens": 12, "completion_tokens": 6, "total_tokens": 18})
        );
    }

    fn ev(event: &str, data: Value) -> SseEvent {
        SseEvent {
            event: event.to_string(),
            data: data.to_string(),
        }
    }

    #[test]
    fn a_mid_stream_error_event_is_surfaced() {
        let c = conv();
        let mut state = StreamState::default();
        c.convert_stream_event(
            &ev("message_start", json!({"message": {"id": "msg_1", "model": "claude-sonnet-4", "usage": {"input_tokens": 10}}})),
            &mut state,
        );
        let out = c.convert_stream_event(
            &ev(
                "error",
                json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
            ),
            &mut state,
        );
        assert_eq!(out.len(), 2);
        let err: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(err["error"]["message"], "Overloaded");
        assert_eq!(out[1], "[DONE]");
        assert!(state.finished);
    }

    #[test]
    fn stream_full_sequence() {
        let c = conv();
        let mut state = StreamState::default();
        c.convert_stream_event(
            &ev("message_start", json!({"message": {"id": "msg_1", "model": "claude-sonnet-4", "usage": {"input_tokens": 10}}})),
            &mut state,
        );
        let block = c.convert_stream_event(
            &ev(
                "content_block_start",
                json!({"index": 0, "content_block": {"type": "text"}}),
            ),
            &mut state,
        );
        // role chunk on first content block
        assert_eq!(block.len(), 1);
        let role: Value = serde_json::from_str(&block[0]).unwrap();
        assert_eq!(role["choices"][0]["delta"]["role"], json!("assistant"));
        assert_eq!(role["id"], json!("msg_1"));

        let text = c.convert_stream_event(
            &ev(
                "content_block_delta",
                json!({"index": 0, "delta": {"type": "text_delta", "text": "hi"}}),
            ),
            &mut state,
        );
        assert_eq!(text.len(), 1);
        let content: Value = serde_json::from_str(&text[0]).unwrap();
        assert_eq!(content["choices"][0]["delta"]["content"], json!("hi"));

        let reasoning = c.convert_stream_event(
            &ev(
                "content_block_delta",
                json!({"index": 0, "delta": {"type": "thinking_delta", "thinking": "why"}}),
            ),
            &mut state,
        );
        let r: Value = serde_json::from_str(&reasoning[0]).unwrap();
        assert_eq!(r["choices"][0]["delta"]["reasoning_content"], json!("why"));

        let done = c.convert_stream_event(
            &ev(
                "message_delta",
                json!({"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 5}}),
            ),
            &mut state,
        );
        assert_eq!(done.len(), 2);
        let finish: Value = serde_json::from_str(&done[0]).unwrap();
        assert_eq!(finish["choices"][0]["finish_reason"], json!("stop"));
        assert_eq!(
            finish["usage"],
            json!({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
        );
        assert_eq!(done[1], "[DONE]");
        assert!(state.finished);
    }

    #[test]
    fn stream_tool_use_emits_header_and_argument_deltas() {
        let c = conv();
        let mut state = StreamState::default();
        let start = c.convert_stream_event(
            &ev("content_block_start", json!({"index": 1, "content_block": {"type": "tool_use", "id": "tu_1", "name": "f"}})),
            &mut state,
        );
        // role chunk + tool header
        assert_eq!(start.len(), 2);
        let header: Value = serde_json::from_str(&start[1]).unwrap();
        let tc = &header["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(tc["index"], json!(0));
        assert_eq!(tc["id"], json!("tu_1"));
        assert_eq!(tc["function"]["name"], json!("f"));

        let arg = c.convert_stream_event(
            &ev("content_block_delta", json!({"index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"a\""}})),
            &mut state,
        );
        let arg_chunk: Value = serde_json::from_str(&arg[0]).unwrap();
        let atc = &arg_chunk["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(atc["index"], json!(0));
        assert_eq!(atc["function"]["arguments"], json!("{\"a\""));
    }

    #[test]
    fn anthropic_thinking_budget_and_sampling_removed() {
        let body = json!({
            "model": "claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 2000,
            "reasoning_effort": "high",
            "temperature": 0.5,
            "top_p": 0.9,
            "top_k": 40,
            "stop": "END",
            "parallel_tool_calls": false,
            "tools": [{"type": "function", "function": {"name": "f", "parameters": {}}}]
        });
        let out = conv().convert_request(&body);
        assert_eq!(
            out["thinking"],
            json!({"type": "enabled", "budget_tokens": 8192})
        );
        assert!(out["max_tokens"].as_i64().unwrap() > 8192);
        assert!(out.get("temperature").is_none());
        assert!(out.get("top_p").is_none());
        assert!(out.get("top_k").is_none());
        assert_eq!(out["stop_sequences"], json!(["END"]));
        assert_eq!(
            out["tool_choice"],
            json!({"type": "auto", "disable_parallel_tool_use": true})
        );

        let plain = json!({"model": "claude-sonnet-4-6", "messages": [], "top_k": 40});
        let out = conv().convert_request(&plain);
        assert!(out.get("thinking").is_none());
        assert_eq!(out["top_k"], json!(40));
        assert_eq!(out["max_tokens"], json!(ANTHROPIC_DEFAULT_MAX_TOKENS));
    }

    #[test]
    fn anthropic_empty_user_message_has_no_empty_block() {
        let with_image = json!({
            "model": "claude-sonnet-4-6",
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": ""},
                {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}
            ]}]
        });
        let out = conv().convert_request(&with_image);
        let blocks = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], json!("image"));

        let empty =
            json!({"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": ""}]});
        let out = conv().convert_request(&empty);
        let blocks = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_ne!(blocks[0]["text"], json!(""));
    }

    #[test]
    fn responses_response_format_to_text_format() {
        let body = json!({
            "model": "gpt-5",
            "messages": [],
            "parallel_tool_calls": false,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "out", "schema": {"type": "object"}, "strict": true
            }}
        });
        let out = OpenAIResponsesConverter::new().convert_request(&body);
        assert_eq!(
            out["text"],
            json!({"format": {"type": "json_schema", "name": "out", "schema": {"type": "object"}, "strict": true}})
        );
        assert_eq!(out["parallel_tool_calls"], json!(false));
    }

    #[test]
    fn responses_request_is_stateless_and_keeps_text_before_calls() {
        let body = json!({
            "model": "gpt-5",
            "messages": [
                {"role": "user", "content": "go"},
                {"role": "assistant", "content": "checking", "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}}
                ]}
            ]
        });
        let out = OpenAIResponsesConverter::new().convert_request(&body);
        assert_eq!(out["store"], json!(false));
        let input = out["input"].as_array().unwrap();
        assert_eq!(input[1]["role"], "assistant");
        assert_eq!(input[1]["content"], "checking");
        assert_eq!(input[2]["type"], "function_call");
    }

    #[test]
    fn sse_accumulator_bounds_an_unterminated_event() {
        let mut acc = SseAccumulator::new();
        let chunk = "x".repeat(1024 * 1024);
        let mut events = Vec::new();
        for _ in 0..5 {
            events.extend(acc.push(&chunk));
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "error");
        // A terminator split over two chunks still ends an event.
        let mut acc = SseAccumulator::new();
        assert!(acc.push("data: 1\n").is_empty());
        assert_eq!(acc.push("\ndata: 2\n\n").len(), 2);
    }

    #[test]
    fn gemini_stop_to_stop_sequences() {
        let body = json!({
            "model": "gemini-2.5-pro",
            "messages": [],
            "stop": ["a", "b"],
            "seed": 7,
            "presence_penalty": 0.5,
            "response_format": {"type": "json_schema", "json_schema": {
                "schema": {"type": "object", "additionalProperties": false,
                           "properties": {"x": {"type": "string"}}}
            }}
        });
        let out = GoogleGenerateContentConverter::new().convert_request(&body);
        let cfg = &out["generationConfig"];
        assert_eq!(cfg["stopSequences"], json!(["a", "b"]));
        assert_eq!(cfg["seed"], json!(7));
        assert_eq!(cfg["presencePenalty"], json!(0.5));
        assert_eq!(cfg["responseMimeType"], json!("application/json"));
        assert!(cfg["responseSchema"].get("additionalProperties").is_none());
        assert_eq!(
            cfg["responseSchema"]["properties"]["x"]["type"],
            json!("string")
        );
    }

    #[test]
    fn unsupported_field_table_per_converter() {
        let body =
            json!({"stop": "x", "seed": 1, "n": 2, "response_format": {"type": "json_object"}});
        assert_eq!(
            unmapped_params(&body, RESPONSES_MAPPED),
            vec!["n", "seed", "stop"]
        );
        assert_eq!(unmapped_params(&body, GEMINI_MAPPED), vec!["n"]);
        assert_eq!(
            unmapped_params(&body, ANTHROPIC_MAPPED),
            vec!["n", "seed", "response_format"]
        );
    }
}
