use futures_util::StreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::Bytes;
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use jan_utils::{is_cors_header, is_trusted_origin, is_valid_host, remove_prefix};
use reqwest::Client;
use serde_json;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri_plugin_llamacpp::state::LlamacppState;
use tokio::sync::Mutex;

use crate::core::server::converters::{
    converter_for, SseAccumulator, StreamState, UpstreamConverter, Utf8ChunkDecoder,
};
use crate::core::{
    mcp::models::McpSettings,
    state::{ProviderConfig, ServerHandle, SharedMcpServers},
};

// Orchestration + upstream plumbing moved to `core/agent`. Re-exported so the
// in-file inline-orchestration call sites and the `proxy::` test references
// keep resolving unchanged.
pub(crate) use crate::core::agent::r#loop::run_server_side_openai_orchestration;
pub(crate) use crate::core::agent::upstream::{
    call_openai_chat_completions, collect_mcp_openai_tools, copy_optional_chat_params,
    execute_mcp_tool_calls, extract_choice_message, extract_tool_calls, load_assistant_config,
    parse_openai_messages, repair_dangling_tool_calls, replace_system_prompt,
    resolve_upstream_for_model,
};
use crate::core::openai_schema::{
    http_status_indicates_api_key_retry, normalize_openai_tools_in_chat_body,
};

type ResBody = BoxBody<Bytes, Infallible>;

/// Whether a client's model name refers to a session's model id. The two
/// differ only by `.` against `_` (`Qwen3_5-9B` for `Qwen3.5-9B`) when a client
/// or a catalog normalises the name, which would otherwise answer 404.
pub(crate) fn model_ids_match(requested: &str, session: &str) -> bool {
    requested == session
        || (requested.len() == session.len()
            && requested
                .chars()
                .zip(session.chars())
                .all(|(a, b)| a == b || (matches!(a, '.' | '_') && matches!(b, '.' | '_'))))
}

/// An OpenAI-style error body, so a client can read `error.code` instead of
/// matching on text. The human message stays in `message` unchanged.
pub(crate) fn error_json(message: &str, kind: &str, code: &str) -> String {
    serde_json::json!({
        "error": { "message": message, "type": kind, "code": code }
    })
    .to_string()
}

/// An engine `exceed_context_size_error` as the Anthropic error Claude Code
/// reads, or `None` for any other body. Its own wording for an oversized
/// prompt ("prompt is too long: N tokens > M maximum") is what makes it compact
/// and retry rather than print an opaque 400, and the hint names the setting
/// that fixes it (janhq/jan#8108).
pub(crate) fn anthropic_context_error(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;
    if error.get("type")?.as_str()? != "exceed_context_size_error" {
        return None;
    }
    let prompt = error.get("n_prompt_tokens").and_then(|v| v.as_u64())?;
    let context = error.get("n_ctx").and_then(|v| v.as_u64())?;
    let message = format!(
        "prompt is too long: {prompt} tokens > {context} maximum. The model is loaded with a \
         {context}-token context; Claude Code needs about 32768. Raise Context Size in the \
         model's settings in Flint, or choose a model with a larger context."
    );
    Some(
        serde_json::json!({
            "type": "error",
            "error": { "type": "invalid_request_error", "message": message }
        })
        .to_string(),
    )
}

/// Whether `url` points at this machine, i.e. a local engine that may simply
/// not be up yet, as opposed to a remote provider.
pub(crate) fn is_local_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .is_some_and(|h| matches!(h.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1"))
}

fn full<B: Into<Bytes>>(chunk: B) -> ResBody {
    Full::new(chunk.into()).boxed()
}

fn empty() -> ResBody {
    Empty::<Bytes>::new().boxed()
}

/// hyper 1.0 dropped `Body::channel`; this mpsc-backed `StreamBody` restores a
/// sender handle for the streaming/passthrough paths. `send_data` returns
/// `Result<(), ()>` so existing `.is_err()` disconnect checks compile unchanged.
struct BodySender(tokio::sync::mpsc::Sender<Result<Frame<Bytes>, Infallible>>);

impl BodySender {
    async fn send_data(&mut self, data: Bytes) -> Result<(), ()> {
        self.0.send(Ok(Frame::data(data))).await.map_err(|_| ())
    }
}

fn body_channel() -> (BodySender, ResBody) {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Frame<Bytes>, Infallible>>(32);
    let body = BodyExt::boxed(StreamBody::new(
        tokio_stream::wrappers::ReceiverStream::new(rx),
    ));
    (BodySender(tx), body)
}

/// Transform Anthropic /messages API body to OpenAI /chat/completions body
pub(crate) fn transform_anthropic_to_openai(body: &serde_json::Value) -> Option<serde_json::Value> {
    let model = body.get("model")?.as_str()?;
    let messages = body.get("messages")?;

    let openai_messages = convert_messages(messages, body.get("system"))?;

    let stream = body
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut result = serde_json::json!({
        "model": model,
        "messages": openai_messages,
        "stream": stream
    });

    // Transform Anthropic tools to OpenAI format
    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        let openai_tools: Vec<serde_json::Value> = tools
            .iter()
            .filter_map(|tool| {
                let name = tool.get("name")?.as_str()?;
                let description = tool
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("");
                let input_schema = tool
                    .get("input_schema")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));

                Some(serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": description,
                        "parameters": input_schema
                    }
                }))
            })
            .collect();

        if !openai_tools.is_empty() {
            result["tools"] = serde_json::Value::Array(openai_tools);
        }
    }

    // Pass through common parameters
    for key in &[
        // "max_tokens",
        "temperature",
        "top_p",
        "top_k",
        "frequency_penalty",
        "presence_penalty",
    ] {
        if let Some(val) = body.get(*key) {
            result[*key] = val.clone();
        }
    }
    if let Some(stop) = body.get("stop_sequences") {
        result["stop"] = stop.clone();
    }

    // Ask the backend for a trailing usage chunk so the stream reports real
    // token counts.
    if stream {
        result["stream_options"] = serde_json::json!({"include_usage": true});
    }

    if let Some(choice) = body.get("tool_choice") {
        let kind = choice.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let mapped = match kind {
            "auto" => Some(serde_json::json!("auto")),
            "any" => Some(serde_json::json!("required")),
            "none" => Some(serde_json::json!("none")),
            "tool" => choice.get("name").and_then(|n| n.as_str()).map(|name| {
                serde_json::json!({"type": "function", "function": {"name": name}})
            }),
            _ => None,
        };
        if let Some(m) = mapped {
            result["tool_choice"] = m;
        }
        if choice
            .get("disable_parallel_tool_use")
            .and_then(|v| v.as_bool())
            == Some(true)
        {
            result["parallel_tool_calls"] = serde_json::json!(false);
        }
    }

    Some(result)
}

/// OpenAI `finish_reason` as an Anthropic `stop_reason`.
fn anthropic_stop_reason(finish_reason: &str) -> &'static str {
    match finish_reason {
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        "content_filter" => "refusal",
        _ => "end_turn",
    }
}

/// OpenAI `usage` as an Anthropic `usage` object.
fn anthropic_usage(usage: &serde_json::Value) -> serde_json::Value {
    let get = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    let mut out = serde_json::json!({
        "input_tokens": get("prompt_tokens"),
        "output_tokens": get("completion_tokens"),
    });
    if let Some(cached) = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
    {
        out["cache_read_input_tokens"] = serde_json::json!(cached);
    }
    out
}

/// Strips the `x-anthropic-billing-header:` attribution that Claude Code
/// prepends to the system prompt / first message. Its values (cc_version, cch,
/// …) are dynamic, so leaving them in the content busts Anthropic prompt
/// caching and leaks CLI metadata to the model. Handles both observed shapes:
///   inline:  "x-anthropic-billing-header: cc_version=…;\n<prompt>"
///   wrapped: "x-anthropic-billing-header:\n   cc_version=…;\n<prompt>"
/// Whether an inbound header is copied onto the upstream request.
///
/// An allow-list: a browser sends `Cookie` for `localhost` (cookies are not
/// port-scoped) and proxies add `Forwarded`/`X-Forwarded-*`, none of which
/// belong at a remote provider. `Host`, `Authorization` and `X-Api-Key` (the
/// caller's credentials for this local server) are consumed here, and
/// `Content-Length`/`Transfer-Encoding` go stale when the body is rewritten.
/// `Origin`/`Referer` describe the calling page, not Flint (janhq/jan#8792).
pub(crate) fn forwards_to_upstream(name: &hyper::header::HeaderName) -> bool {
    let n = name.as_str();
    matches!(n, "content-type" | "accept" | "accept-encoding" | "user-agent")
        || n.starts_with("openai-")
        || n.starts_with("anthropic-")
        || n.starts_with("x-stainless-")
}

/// Largest request body the API server buffers (bytes). 64 MiB by default,
/// `FLINT_API_MAX_BODY_MB` overrides it for very large inline images.
fn max_api_body() -> usize {
    std::env::var("FLINT_API_MAX_BODY_MB")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|mb| *mb > 0)
        .unwrap_or(64)
        .saturating_mul(1024 * 1024)
}

const BODY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const HEADER_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const MAX_CONNECTIONS: usize = 256;

/// Why a request body was not buffered.
#[derive(Debug, PartialEq)]
pub(crate) enum BodyReadError {
    TooLarge,
    TimedOut,
    Failed,
}

/// Buffer a request body, refusing more than `cap` bytes. A declared
/// `Content-Length` over the cap is refused before any byte is read; a chunked
/// body is cut off at the cap. The whole read is bounded in time.
pub(crate) async fn read_limited<B>(body: B, cap: usize) -> Result<Bytes, BodyReadError>
where
    B: hyper::body::Body,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    if body.size_hint().lower() > cap as u64 {
        return Err(BodyReadError::TooLarge);
    }
    let limited = http_body_util::Limited::new(body, cap);
    match tokio::time::timeout(BODY_READ_TIMEOUT, limited.collect()).await {
        Err(_) => Err(BodyReadError::TimedOut),
        Ok(Ok(c)) => Ok(c.to_bytes()),
        Ok(Err(e)) if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() => {
            Err(BodyReadError::TooLarge)
        }
        Ok(Err(_)) => Err(BodyReadError::Failed),
    }
}

fn body_error_response(
    err: BodyReadError,
    host: &str,
    origin: &str,
    trusted_hosts: &[Vec<String>],
) -> Response<ResBody> {
    let (status, msg) = match err {
        BodyReadError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
        BodyReadError::TimedOut => (StatusCode::REQUEST_TIMEOUT, "Timed out reading request body"),
        BodyReadError::Failed => (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read request body"),
    };
    add_cors_headers_with_host_and_origin(
        Response::builder().status(status),
        host,
        origin,
        trusted_hosts,
    )
    .body(full(msg))
    .unwrap()
}

/// 502 for a /messages -> /chat/completions fallback that could not reach the
/// provider (instead of echoing the first, unrelated failure).
fn fallback_failure_response(
    detail: &str,
    host: &str,
    origin: &str,
    trusted_hosts: &[Vec<String>],
) -> Response<ResBody> {
    let body = serde_json::json!({
        "type": "error",
        "error": {"type": "api_error", "message": format!("Fallback to chat completions failed: {detail}")}
    });
    add_cors_headers_with_host_and_origin(
        Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header("Content-Type", "application/json"),
        host,
        origin,
        trusted_hosts,
    )
    .body(full(body.to_string()))
    .unwrap()
}

/// A provider's configured headers that form a valid header, so one bad
/// entry cannot fail the whole request build.
pub(crate) fn custom_header_pairs(cfg: &crate::core::state::ProviderConfig) -> Vec<(String, String)> {
    cfg.custom_headers
        .iter()
        .filter(|h| {
            hyper::header::HeaderName::from_bytes(h.header.trim().as_bytes()).is_ok()
                && hyper::header::HeaderValue::from_str(&h.value).is_ok()
        })
        .map(|h| (h.header.trim().to_string(), h.value.clone()))
        .collect()
}

pub(crate) fn strip_anthropic_billing_header(text: &str) -> &str {
    const KEY: &str = "x-anthropic-billing-header:";
    // `get`, not `[..]`: the length is in bytes, and a prompt that starts with
    // multi-byte text puts that byte in the middle of a character. Indexing
    // there panicked the request handler, and the local API server closed the
    // connection without a response for any system prompt whose alignment
    // happened to land that way (janhq/jan#8358).
    if !text
        .get(..KEY.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(KEY))
    {
        return text;
    }
    let first_nl = match text.find('\n') {
        Some(i) => i,
        None => return text,
    };
    let after_first = &text[first_nl + 1..];

    // Inline form: metadata sits on the header line itself.
    if text[..first_nl].contains("cc_version=") || text[..first_nl].contains("cc_entrypoint=") {
        return after_first;
    }
    // Wrapped form: metadata is the continuation line.
    if let Some(rel) = after_first.find('\n') {
        let cont = &after_first[..rel];
        if cont.contains("cc_version=") || cont.contains("cc_entrypoint=") || cont.contains("cch=")
        {
            return &after_first[rel + 1..];
        }
    }
    text
}

/// Applies `strip_anthropic_billing_header` to a message/system `content` value
/// (a bare string or an array of content blocks — only the first text block can
/// carry the header).
fn strip_billing_header_in_content(content: &mut serde_json::Value) {
    match content {
        serde_json::Value::String(s) => {
            let stripped = strip_anthropic_billing_header(s);
            if stripped.len() != s.len() {
                *s = stripped.to_string();
            }
        }
        serde_json::Value::Array(blocks) => {
            for block in blocks.iter_mut() {
                if let Some(text_val) = block.get_mut("text") {
                    if let Some(orig) = text_val.as_str() {
                        let stripped = strip_anthropic_billing_header(orig);
                        if stripped.len() != orig.len() {
                            let owned = stripped.to_string();
                            *text_val = serde_json::Value::String(owned);
                        }
                    }
                    break;
                }
            }
        }
        _ => {}
    }
}

/// Strips the Claude Code billing header from an in-flight request body, in
/// place, before it is forwarded upstream. Covers the Anthropic `system` field
/// and the first message's content (the only places Claude Code injects it).
pub(crate) fn strip_billing_header_in_body(body: &mut serde_json::Value) {
    if let Some(system) = body.get_mut("system") {
        strip_billing_header_in_content(system);
    }
    if let Some(first) = body
        .get_mut("messages")
        .and_then(|v| v.as_array_mut())
        .and_then(|arr| arr.first_mut())
    {
        if let Some(content) = first.get_mut("content") {
            strip_billing_header_in_content(content);
        }
    }
}

/// Fills in top-level sampling defaults the caller omitted. Used for MLX
/// targets, which (unlike the llama.cpp router) have no preset to carry
/// server-side defaults. `defaults` is already in the target's key form
/// (e.g. `repetition_penalty`, not `repeat_penalty`); a present key is never
/// overwritten, so a per-request value always wins.
pub(crate) fn inject_sampling_defaults(body: &mut serde_json::Value, defaults: &serde_json::Value) {
    let (Some(obj), Some(defaults_obj)) = (body.as_object_mut(), defaults.as_object()) else {
        return;
    };
    for (k, v) in defaults_obj {
        if !obj.contains_key(k) {
            obj.insert(k.clone(), v.clone());
        }
    }
}

/// Convert Anthropic message format to OpenAI format
pub(crate) fn convert_messages(
    anth_messages: &serde_json::Value,
    system_prompt: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    let messages_array = anth_messages.as_array()?;
    let mut openai_messages: Vec<serde_json::Value> = Vec::new();
    // Anthropic's system prompt is a top-level field: a leading system message.
    openai_messages.extend(system_prompt.and_then(top_level_system_message));
    for msg in messages_array {
        let role = msg.get("role")?.as_str()?;
        let content = msg.get("content")?;
        if content.is_string() {
            if let Some(openai_role) = plain_role(role) {
                openai_messages.push(serde_json::json!({
                    "role": openai_role,
                    "content": content
                }));
            }
            continue;
        }
        let blocks = content.as_array()?;
        match role {
            "assistant" => openai_messages.push(assistant_blocks_message(blocks)),
            "user" => push_user_blocks(blocks, &mut openai_messages),
            "system" | "developer" => openai_messages.push(serde_json::json!({
                "role": role,
                "content": joined_block_text(blocks)
            })),
            _ => {}
        }
    }
    Some(serde_json::Value::Array(merge_system_messages(openai_messages)))
}

/// The roles a string-content message keeps; any other is dropped.
fn plain_role(role: &str) -> Option<&'static str> {
    match role {
        "user" => Some("user"),
        "assistant" => Some("assistant"),
        "system" => Some("system"),
        "developer" => Some("developer"),
        _ => None,
    }
}

/// The `text` of every block that has one, joined by newlines.
fn joined_block_text(blocks: &[serde_json::Value]) -> String {
    blocks
        .iter()
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The top-level `system` field (a string, or text blocks) as a system
/// message; `None` for empty block text or another shape.
fn top_level_system_message(system: &serde_json::Value) -> Option<serde_json::Value> {
    let text = match (system.as_str(), system.as_array()) {
        (Some(text), _) => text.to_string(),
        (None, Some(blocks)) => Some(joined_block_text(blocks)).filter(|t| !t.is_empty())?,
        (None, None) => return None,
    };
    Some(serde_json::json!({ "role": "system", "content": text }))
}

fn text_part(block: &serde_json::Value) -> Option<serde_json::Value> {
    let text = block.get("text").and_then(|v| v.as_str())?;
    Some(serde_json::json!({ "type": "text", "text": text }))
}

/// An assistant turn's blocks as one chat message: text and media as
/// content, `tool_use` blocks as `tool_calls`.
fn assistant_blocks_message(blocks: &[serde_json::Value]) -> serde_json::Value {
    let mut text_parts: Vec<serde_json::Value> = Vec::new();
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "text" => text_parts.extend(text_part(block)),
            "tool_use" => {
                if let (Some(id), Some(name), Some(input)) = (
                    block.get("id").and_then(|v| v.as_str()),
                    block.get("name").and_then(|v| v.as_str()),
                    block.get("input"),
                ) {
                    tool_calls.push(serde_json::json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": input.to_string()
                        }
                    }));
                }
            }
            _ => convert_media_block(block, &mut text_parts),
        }
    }
    let mut msg_obj = serde_json::json!({ "role": "assistant" });
    if tool_calls.is_empty() {
        msg_obj["content"] = text_parts_to_content(&text_parts);
    } else {
        // With tool calls the content may be null.
        msg_obj["content"] = if text_parts.is_empty() {
            serde_json::Value::Null
        } else {
            text_parts_to_content(&text_parts)
        };
        msg_obj["tool_calls"] = serde_json::Value::Array(tool_calls);
    }
    msg_obj
}

/// A user turn's blocks: each `tool_result` as a `tool` message (they must
/// come first), then the remaining text and media as one user message.
fn push_user_blocks(blocks: &[serde_json::Value], out: &mut Vec<serde_json::Value>) {
    let mut text_parts: Vec<serde_json::Value> = Vec::new();
    let mut tool_results: Vec<(String, String)> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "tool_result" => tool_results.push(tool_result_text(block, &mut text_parts)),
            "text" => text_parts.extend(text_part(block)),
            _ => convert_media_block(block, &mut text_parts),
        }
    }
    for (tool_call_id, result) in tool_results {
        out.push(serde_json::json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": result
        }));
    }
    if !text_parts.is_empty() {
        out.push(serde_json::json!({
            "role": "user",
            "content": text_parts_to_content(&text_parts)
        }));
    }
}

/// A `tool_result` block's call id and text. Its images go to `media`: a
/// tool message carries only text here, so they follow as user content.
fn tool_result_text(block: &serde_json::Value, media: &mut Vec<serde_json::Value>) -> (String, String) {
    let tool_use_id = block
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut result_content = extract_tool_result_content(block.get("content"));
    // A failed call must read as one: chat/completions has no `is_error`
    // flag on a tool message.
    if block.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
        result_content = format!("Error: {result_content}");
    }
    for part in block.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
        if part.get("type").and_then(|t| t.as_str()) != Some("text") {
            convert_media_block(part, media);
        }
    }
    (tool_use_id, result_content)
}

/// Collapse every system/developer message into one leading system message.
/// Strict chat templates (Qwen3 and others) reject a system message anywhere
/// but the start, and clients such as Claude Code send several.
pub(crate) fn merge_system_messages(messages: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let is_system = |m: &serde_json::Value| {
        matches!(
            m.get("role").and_then(|r| r.as_str()),
            Some("system") | Some("developer")
        )
    };
    if messages.iter().filter(|m| is_system(m)).count() == 0 {
        return messages;
    }
    let mut system_text: Vec<String> = Vec::new();
    let mut rest: Vec<serde_json::Value> = Vec::with_capacity(messages.len());
    for m in messages {
        if is_system(&m) {
            match m.get("content") {
                Some(serde_json::Value::String(t)) => system_text.push(t.clone()),
                Some(serde_json::Value::Array(parts)) => system_text.push(
                    parts
                        .iter()
                        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("
"),
                ),
                _ => {}
            }
        } else {
            rest.push(m);
        }
    }
    system_text.retain(|t| !t.is_empty());
    if system_text.is_empty() {
        return rest;
    }
    let mut out = Vec::with_capacity(rest.len() + 1);
    out.push(serde_json::json!({ "role": "system", "content": system_text.join("

") }));
    out.extend(rest);
    out
}

/// Convert text parts to OpenAI content value (string for single text, array for mixed)
pub(crate) fn text_parts_to_content(parts: &[serde_json::Value]) -> serde_json::Value {
    if parts.is_empty() {
        serde_json::Value::String(String::new())
    } else if parts.len() == 1 && parts[0].get("type").and_then(|t| t.as_str()) == Some("text") {
        serde_json::Value::String(
            parts[0]
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
        )
    } else {
        serde_json::Value::Array(parts.to_vec())
    }
}

/// Convert image/media blocks to OpenAI format
pub(crate) fn convert_media_block(block: &serde_json::Value, parts: &mut Vec<serde_json::Value>) {
    let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if block_type == "image" {
        if let Some(source) = block.get("source") {
            if let (Some(data), Some(media_type)) = (
                source.get("data").and_then(|v| v.as_str()),
                source
                    .get("media_type")
                    .or(block.get("media_type"))
                    .and_then(|v| v.as_str()),
            ) {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{media_type};base64,{data}")
                    }
                }));
            }
        }
    } else if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
        parts.push(serde_json::json!({
            "type": "text",
            "text": text
        }));
    }
}

/// Extract text content from a tool_result content field
pub(crate) fn extract_tool_result_content(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(c) if c.is_string() => c.as_str().unwrap_or("").to_string(),
        Some(c) if c.is_array() => c
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(c) => c.to_string(),
        None => String::new(),
    }
}

/// Transform OpenAI non-streaming response to Anthropic /messages format
pub(crate) fn transform_openai_response_to_anthropic(
    response: &serde_json::Value,
) -> serde_json::Value {
    let choice = response
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first());
    let message = choice.and_then(|c| c.get("message"));

    let mut content_blocks: Vec<serde_json::Value> = Vec::new();

    // Add text content
    if let Some(text) =
        message
            .and_then(|m| m.get("content"))
            .and_then(|c| if c.is_null() { None } else { c.as_str() })
    {
        if !text.is_empty() {
            content_blocks.push(serde_json::json!({
                "type": "text",
                "text": text
            }));
        }
    }

    // Add tool_use blocks from tool_calls
    if let Some(tool_calls) = message
        .and_then(|m| m.get("tool_calls"))
        .and_then(|tc| tc.as_array())
    {
        for tc in tool_calls {
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let arguments = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|a| a.as_str())
                .unwrap_or("{}");
            let input: serde_json::Value =
                serde_json::from_str(arguments).unwrap_or(serde_json::json!({}));

            content_blocks.push(serde_json::json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }));
        }
    }

    let finish_reason = choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|fr| fr.as_str())
        .unwrap_or("end_turn");

    let stop_reason = anthropic_stop_reason(finish_reason);

    serde_json::json!({
        "id": response.get("id").unwrap_or(&serde_json::json!("")).clone(),
        "type": "message",
        "role": "assistant",
        "content": content_blocks,
        "model": response.get("model").unwrap_or(&serde_json::json!("")).clone(),
        "stop_reason": stop_reason,
        "stop_sequence": serde_json::Value::Null,
        "usage": anthropic_usage(response.get("usage").unwrap_or(&serde_json::Value::Null))
    })
}

/// Which remote provider serves `model_id`, the same way every run.
///
/// Providers that list the id are the candidates. One candidate wins outright.
/// With several, the `provider/` prefix of the id picks among them when it names
/// one; otherwise the first by provider key wins and the choice is logged, so
/// the answer no longer depends on `HashMap` iteration order. With none listing
/// it, a `provider/` prefix that names a configured provider, or the id itself
/// naming one, decides.
fn resolve_provider_name(
    pc: &HashMap<String, ProviderConfig>,
    model_id: &str,
) -> Option<String> {
    let prefix = model_id.find('/').map(|at| &model_id[..at]);
    let mut candidates: Vec<(&String, &ProviderConfig)> = pc
        .iter()
        .filter(|(_, config)| config.models.iter().any(|m| m == model_id))
        .collect();
    candidates.sort_by(|a, b| a.0.cmp(b.0));
    match candidates.as_slice() {
        [] => {}
        [(_, only)] => return Some(only.provider.clone()),
        several => {
            let named = prefix.and_then(|p| several.iter().find(|(key, _)| key.as_str() == p));
            let chosen = named.unwrap_or(&several[0]);
            if named.is_none() {
                log::warn!(
                    "Model '{model_id}' is listed by several providers ({}); using '{}'. \
                     Prefix the id with the provider name to choose.",
                    several.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", "),
                    chosen.0
                );
            }
            return Some(chosen.1.provider.clone());
        }
    }
    if let Some(prefix) = prefix {
        if pc.contains_key(prefix) {
            return Some(prefix.to_string());
        }
    }
    pc.get(model_id).map(|c| c.provider.clone())
}

/// Configuration for the proxy server
#[derive(Clone)]
pub struct ProxyConfig {
    pub prefix: String,
    pub proxy_api_key: String,
    pub trusted_hosts: Vec<Vec<String>>,
    pub host: String,
    pub port: u16,
    pub enable_server_tool_execution: bool,
    /// The Settings "CORS" switch. Off, no response grants a page on another
    /// origin access, the preflight included (janhq/jan#8836).
    pub cors_enabled: bool,
}

/// Remove every `Access-Control-*` header from a response, including any a
/// backend sent, so a browser page on another origin is refused.
pub(crate) fn strip_cors_headers<B>(response: &mut Response<B>) {
    let names: Vec<_> = response
        .headers()
        .keys()
        .filter(|name| name.as_str().starts_with("access-control-"))
        .cloned()
        .collect();
    for name in names {
        response.headers_mut().remove(&name);
    }
}

/// Determines the final destination path based on the original request path
pub fn get_destination_path(original_path: &str, prefix: &str) -> String {
    remove_prefix(original_path, prefix)
}

use crate::core::server::MlxBackendSession;

/// The loopback endpoint local-model requests are forwarded to: the engine
/// worker's `/v1` surface, or None when no engine is running.
pub(crate) async fn engine_upstream(
    llama_state: &LlamacppState,
    destination_path: &str,
) -> Option<(String, String)> {
    let mut guard = llama_state.engine.lock().await;
    // A worker that died (abort, OOM, device loss) leaves its port closed. Reap
    // it here so API-only clients get the "no model loaded" answer instead of an
    // opaque connection-refused 503 until the UI happens to restart it (#259).
    if let Some(h) = guard.as_mut() {
        if let Some(status) = h.exited() {
            log::warn!("flint-llama-worker exited unexpectedly: {status}");
            *guard = None;
            return None;
        }
    }
    guard.as_ref().map(|h| {
        (
            format!("http://127.0.0.1:{}/v1{}", h.port, destination_path),
            h.api_key.clone(),
        )
    })
}

pub(crate) async fn engine_list_models(
    llama_state: &LlamacppState,
    client: &Client,
) -> Vec<String> {
    engine_list_model_entries(llama_state, client)
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

/// The context window the engine reports for a loaded model: the value after
/// `--ctx-size` / `-c` in the router entry's `status.args`, or `meta.n_ctx`.
/// None when the engine does not say (an unloaded model, an older build).
fn engine_context_length(entry: &serde_json::Value) -> Option<u64> {
    let args = entry.pointer("/status/args")?.as_array();
    let from_args = args.and_then(|args| {
        args.windows(2).find_map(|pair| match pair[0].as_str() {
            Some("--ctx-size") | Some("-c") => pair[1].as_str()?.parse::<u64>().ok(),
            _ => None,
        })
    });
    from_args
        .or_else(|| entry.pointer("/meta/n_ctx").and_then(|v| v.as_u64()))
        .filter(|n| *n > 0)
}

/// The context window Flint configured for `model_id`: the `ctx-size` its
/// section (or the shared `[*]` block) of `router.preset.ini` sets, which the
/// worker loads the model with. None when unset or `0` (the model's trained
/// default, which only the engine knows).
fn preset_context_length(preset_ini: &str, model_id: &str) -> Option<u64> {
    tauri_plugin_llamacpp::engine::preset::section_value(preset_ini, model_id, "ctx-size")?
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
}

/// Engine model ids with the context window it reports for each, when known.
pub(crate) async fn engine_list_model_entries(
    llama_state: &LlamacppState,
    client: &Client,
) -> Vec<(String, Option<u64>)> {
    let (url, key) = match engine_upstream(llama_state, "/models").await {
        Some(v) => v,
        None => return Vec::new(),
    };
    let resp = match client
        .get(&url)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("Failed to query the engine's /v1/models: {e}");
            return Vec::new();
        }
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    json.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|v| v.as_str())?.to_owned();
                    Some((id, engine_context_length(m)))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) async fn router_first_model(
    llama_state: &LlamacppState,
    client: &Client,
) -> Option<String> {
    engine_list_models(llama_state, client)
        .await
        .into_iter()
        .next()
}

/// The Settings "Verbose Server Logs" switch (#144). Set by each
/// `start_server` command; read on every request.
static VERBOSE_LOGS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_verbose_logs(on: bool) {
    VERBOSE_LOGS.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub fn verbose_logs() -> bool {
    VERBOSE_LOGS.load(std::sync::atomic::Ordering::Relaxed)
}

/// The line a verbose server logs for a request. The query string is left
/// out: a client can put a key in it, and the log is shared in bug reports.
fn verbose_request_line(method: &hyper::Method, uri: &hyper::Uri) -> String {
    format!("API server request: {method} {}", uri.path())
}

/// Answers a CORS preflight (`OPTIONS`): the host, the requested method and the
/// requested headers are checked, and the origin is reflected only when trusted.
fn handle_preflight(
    req: &Request<Incoming>,
    config: &ProxyConfig,
) -> Result<Response<ResBody>, hyper::Error> {
    log::debug!(
        "Handling CORS preflight request from {:?} {:?}",
        req.headers().get(hyper::header::HOST),
        req.headers()
            .get(hyper::header::ACCESS_CONTROL_REQUEST_METHOD)
    );

    let host = req
        .headers()
        .get(hyper::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let origin = req
        .headers()
        .get(hyper::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let requested_method = req
        .headers()
        .get("Access-Control-Request-Method")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let allowed_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"];
    let method_allowed = requested_method.is_empty()
        || allowed_methods
            .iter()
            .any(|&method| method.eq_ignore_ascii_case(requested_method));

    if !method_allowed {
        log::warn!("CORS preflight: Method '{requested_method}' not allowed");
        return Ok(Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .body(full("Method not allowed"))
            .unwrap());
    }

    let request_path = req.uri().path();
    let whitelisted_paths = ["/", "/openapi.json", "/favicon.ico"];
    let is_whitelisted_path = whitelisted_paths.contains(&request_path);

    let is_trusted = if is_whitelisted_path {
        log::debug!(
            "CORS preflight: Bypassing host check for whitelisted path: {request_path}"
        );
        true
    } else if !host.is_empty() {
        log::debug!(
            "CORS preflight: Host is '{host}', trusted hosts: {:?}",
            config.trusted_hosts
        );
        is_valid_host(host, &config.trusted_hosts)
    } else {
        log::warn!("CORS preflight: No Host header present");
        false
    };

    if !is_trusted {
        log::warn!("CORS preflight: Host '{host}' not trusted for path '{request_path}'");
        return Ok(Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(full("Host not allowed"))
            .unwrap());
    }

    let requested_headers = req
        .headers()
        .get("Access-Control-Request-Headers")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let allowed_headers = [
        "accept",
        "accept-language",
        "authorization",
        "cache-control",
        "connection",
        "content-type",
        "dnt",
        "host",
        "if-modified-since",
        "keep-alive",
        "origin",
        "user-agent",
        "x-api-key",
        "x-csrf-token",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-requested-with",
        "x-stainless-arch",
        "x-stainless-lang",
        "x-stainless-os",
        "x-stainless-package-version",
        "x-stainless-retry-count",
        "x-stainless-runtime",
        "x-stainless-runtime-version",
        "x-stainless-timeout",
    ];

    let headers_valid = if requested_headers.is_empty() {
        true
    } else {
        requested_headers
            .split(',')
            .map(|h| h.trim())
            .all(|header| {
                allowed_headers
                    .iter()
                    .any(|&allowed| allowed.eq_ignore_ascii_case(header))
            })
    };

    if !headers_valid {
        log::warn!("CORS preflight: Some requested headers not allowed: {requested_headers}");
        return Ok(Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(full("Headers not allowed"))
            .unwrap());
    }

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header("Access-Control-Allow-Methods", allowed_methods.join(", "))
        .header("Access-Control-Allow-Headers", allowed_headers.join(", "))
        .header("Access-Control-Max-Age", "86400")
        .header(
            "Vary",
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        );

    if !origin.is_empty() {
        if origin_is_trusted(origin, &config.trusted_hosts) {
            response = response
                .header("Access-Control-Allow-Origin", origin)
                .header("Access-Control-Allow-Credentials", "true");
        } else {
            log::warn!(
                "CORS preflight: Origin '{origin}' is not trusted, not reflecting origin"
            );
        }
    }

    log::debug!("CORS preflight response: host_trusted={is_trusted}, origin='{origin}'");
    return Ok(response.body(empty()).unwrap());
}

/// Paths served without a host check or credentials: the docs and the root page.
const WHITELISTED_PATHS: [&str; 6] = [
    "/",
    "/openapi.json",
    "/favicon.ico",
    "/docs/swagger-ui.css",
    "/docs/swagger-ui-bundle.js",
    "/docs/swagger-ui-standalone-preset.js",
];

/// The checks every request passes before it is routed: a trusted `Host`, no
/// foreign `Origin` when no key is set, the API key, and the hidden `/configs`.
/// `Some(response)` refuses the request with CORS headers already applied;
/// `None` lets it through. Order is the security model: host, origin, key.
fn check_request(
    parts: &hyper::http::request::Parts,
    path: &str,
    host_header: &str,
    origin_header: &str,
    config: &ProxyConfig,
) -> Option<Response<ResBody>> {
    let is_whitelisted_path = WHITELISTED_PATHS.contains(&path);

    if !is_whitelisted_path {
        if !host_header.is_empty() {
            if !is_valid_host(host_header, &config.trusted_hosts) {
                let mut error_response = Response::builder().status(StatusCode::FORBIDDEN);
                error_response = add_cors_headers_with_host_and_origin(
                    error_response,
                    host_header,
                    origin_header,
                    &config.trusted_hosts,
                );
                return Some(error_response.body(full("Invalid host header")).unwrap());
            }
        } else {
            let mut error_response = Response::builder().status(StatusCode::BAD_REQUEST);
            error_response = add_cors_headers_with_host_and_origin(
                error_response,
                host_header,
                origin_header,
                &config.trusted_hosts,
            );
            return Some(error_response.body(full("Missing host header")).unwrap());
        }
    } else {
        log::debug!("Bypassing host validation for whitelisted path: {path}");
    }

    // A page in the user's browser can send a "simple" cross-origin request to
    // 127.0.0.1 without a preflight; CORS only hides the answer, the request
    // still runs. With no API key that would spend credits or load models on
    // behalf of any website, so a foreign Origin is refused outright.
    if !is_whitelisted_path
        && !origin_header.is_empty()
        && config.proxy_api_key.is_empty()
        && !origin_is_trusted(origin_header, &config.trusted_hosts)
    {
        let mut error_response = Response::builder().status(StatusCode::FORBIDDEN);
        error_response = add_cors_headers_with_host_and_origin(
            error_response,
            host_header,
            origin_header,
            &config.trusted_hosts,
        );
        return Some(error_response.body(full("Untrusted origin")).unwrap());
    }

    if !is_whitelisted_path && !config.proxy_api_key.is_empty() {
        // Check Authorization header (Bearer token)
        let auth_valid = parts
            .headers
            .get(hyper::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(bearer_token)
            .map(|token| keys_equal(token, &config.proxy_api_key))
            .unwrap_or(false);

        // Check X-Api-Key header
        let api_key_valid = parts
            .headers
            .get("X-Api-Key")
            .and_then(|v| v.to_str().ok())
            .map(|key| keys_equal(key, &config.proxy_api_key))
            .unwrap_or(false);

        if !auth_valid && !api_key_valid {
            let mut error_response = Response::builder().status(StatusCode::UNAUTHORIZED);
            error_response = add_cors_headers_with_host_and_origin(
                error_response,
                host_header,
                origin_header,
                &config.trusted_hosts,
            );
            return Some(error_response
                .body(full("Invalid or missing authorization token"))
                .unwrap());
        }
    } else if is_whitelisted_path {
        log::debug!("Bypassing authorization check for whitelisted path: {path}");
    }

    if path.contains("/configs") {
        let mut error_response = Response::builder().status(StatusCode::NOT_FOUND);
        error_response = add_cors_headers_with_host_and_origin(
            error_response,
            host_header,
            origin_header,
            &config.trusted_hosts,
        );
        return Some(error_response.body(full("Not Found")).unwrap());
    }

    None
}

/// Answers on these routes spend tokens, so they count toward the rolling
/// ceilings in quotas.toml and are refused with a 429 once one is reached.
fn is_metered(method: &hyper::Method, destination_path: &str) -> bool {
    *method == hyper::Method::POST
        && matches!(
            destination_path,
            "/chat/completions" | "/completions" | "/messages" | "/orchestrations"
        )
}

/// Refuses a metered request (a route that spends tokens) once a rolling
/// ceiling in `quotas.toml` is reached: a 429 with the retry and headroom headers.
fn quota_refusal(
    method: &hyper::Method,
    destination_path: &str,
    host_header: &str,
    origin_header: &str,
    config: &ProxyConfig,
    jan_data_folder: &str,
) -> Option<Response<ResBody>> {
    if is_metered(method, destination_path) {
        if let Some(refused) =
            super::usage_meter::refusal(std::path::Path::new(&jan_data_folder))
        {
            let mut error_response = Response::builder()
                .status(StatusCode::TOO_MANY_REQUESTS)
                .header("Content-Type", "application/json")
                .header("Retry-After", refused.retry_after_secs.to_string());
            if let Some(room) =
                super::usage_meter::headroom(std::path::Path::new(&jan_data_folder))
            {
                for (name, value) in room.headers() {
                    error_response = error_response.header(name, value);
                }
            }
            error_response = add_cors_headers_with_host_and_origin(
                error_response,
                host_header,
                origin_header,
                &config.trusted_hosts,
            );
            return Some(error_response
                .body(full(error_json(
                    &refused.message,
                    "rate_limit_error",
                    "rate_limit_exceeded",
                )))
                .unwrap());
        }
    }

    None
}

/// What route resolution decides for a request that is forwarded upstream; the
/// routes fill it in and the forwarding code below the route match reads it.
#[derive(Default)]
struct ForwardPlan {
    session_api_keys: Vec<String>,
    /// The provider's configured headers (Azure `api-key`, APIM subscription
    /// keys, ...), sent on every upstream attempt like the bearer key.
    provider_headers: Vec<(String, String)>,
    buffered_body: Option<Bytes>,
    target_base_url: Option<String>,
    is_anthropic_messages: bool,
    /// Set when the resolved remote provider fronts a non-chat/completions native
    /// API; drives request rewrite + response translation back to chat shape.
    upstream_converter: Option<Box<dyn UpstreamConverter>>,
    /// Model id when the request resolves to an MLX session -- MLX has no preset,
    /// so sampling defaults are injected into the body before forwarding.
    mlx_model_id: Option<String>,
    /// The id a request to the bundled engine named. The engine answers with the
    /// model's file path in `model`; the response is given this id back.
    engine_model_id: Option<String>,
}

/// Handles the proxy request logic
#[allow(clippy::too_many_arguments)]
async fn proxy_request(
    req: Request<Incoming>,
    client: Client,
    local_client: Client,
    config: ProxyConfig,
    llama_state: Arc<LlamacppState>,
    mlx_sessions: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    provider_configs: Arc<Mutex<HashMap<String, ProviderConfig>>>,
    model_param_defaults: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    mcp_servers: SharedMcpServers,
    mcp_settings: Arc<Mutex<McpSettings>>,
    jan_data_folder: String,
) -> Result<Response<ResBody>, hyper::Error> {
    if verbose_logs() {
        log::info!("{}", verbose_request_line(req.method(), req.uri()));
    }
    if req.method() == hyper::Method::OPTIONS {
        return handle_preflight(&req, &config);
    }

    let (parts, body) = req.into_parts();

    let origin_header = parts
        .headers
        .get(hyper::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let host_header = parts
        .headers
        .get(hyper::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let original_path = parts.uri.path();
    let headers = parts.headers.clone();

    let path = get_destination_path(original_path, &config.prefix);
    let method = parts.method.clone();

    if let Some(refusal) = check_request(&parts, &path, &host_header, &origin_header, &config) {
        return Ok(refusal);
    }

    let original_path = parts.uri.path();
    let destination_path = get_destination_path(original_path, &config.prefix);

    if let Some(refusal) = quota_refusal(
        &method,
        &destination_path,
        &host_header,
        &origin_header,
        &config,
        &jan_data_folder,
    ) {
        return Ok(refusal);
    }
    let metered = is_metered(&method, &destination_path);

    // What route resolution decides for a request that is forwarded upstream.
    let mut plan = ForwardPlan::default();

    match (method.clone(), destination_path.as_str()) {
        // OpenAI Responses API: rewritten to a chat/completions call on this
        // same server and the answer rewritten back (see `responses_route`).
        (hyper::Method::POST, "/responses") => {
            let collected = match read_limited(body, max_api_body()).await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(body_error_response(e, &host_header, &origin_header, &config.trusted_hosts));
                }
            };
            let url = super::responses_route::loopback_url(&config.host, config.port, &config.prefix);
            let handled = super::responses_route::handle(&collected, &headers, &url, &local_client).await;
            let mut response = Response::builder()
                .status(handled.status)
                .header("Content-Type", handled.content_type);
            if handled.content_type == "text/event-stream" {
                response = response.header("Cache-Control", "no-cache");
            }
            response = add_cors_headers_with_host_and_origin(
                response,
                &host_header,
                &origin_header,
                &config.trusted_hosts,
            );
            return Ok(response.body(handled.body).unwrap());
        }
        // Anthropic /messages endpoint - tries /messages first, falls back to /chat/completions on error
        (hyper::Method::POST, "/messages") => {
            plan.is_anthropic_messages = true;
            log::info!(
                "Handling POST request to /messages with chat/completions fallback on error",
            );
            let body_bytes = match read_limited(body, max_api_body()).await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(body_error_response(
                        e,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    ));
                }
            };
            plan.buffered_body = Some(body_bytes.clone());

            // Parse body to get model_id for routing (don't transform yet)
            match serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                Ok(mut json_body) => {
                    // Drop Claude Code's billing-header attribution before it is
                    // forwarded (passthrough) or transformed, so it can't bust
                    // upstream prompt caching or reach the model.
                    strip_billing_header_in_body(&mut json_body);
                    if let Ok(cleaned) = serde_json::to_vec(&json_body) {
                        plan.buffered_body = Some(cleaned.into());
                    }

                    if config.enable_server_tool_execution
                        && !json_body
                            .get("stream")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                    {
                        let openai_body = match transform_anthropic_to_openai(&json_body) {
                            Some(v) => v,
                            None => {
                                let mut error_response =
                                    Response::builder().status(StatusCode::BAD_REQUEST);
                                error_response = add_cors_headers_with_host_and_origin(
                                    error_response,
                                    &host_header,
                                    &origin_header,
                                    &config.trusted_hosts,
                                );
                                return Ok(error_response
                                    .body(full("Invalid /messages payload for orchestration mode"))
                                    .unwrap());
                            }
                        };

                        match run_server_side_openai_orchestration(
                            &openai_body,
                            // The agent loop runs on genai (reqwest 0.13); the
                            // proxy's own passthrough stays on 0.12.
                            &crate::core::agent::upstream::agent_http_client(),
                            provider_configs.clone(),
                            llama_state.clone(),
                            mlx_sessions.clone(),
                            mcp_servers.clone(),
                            mcp_settings.clone(),
                            &jan_data_folder,
                        )
                        .await
                        {
                            Ok(openai_response) => {
                                let anthropic_response =
                                    transform_openai_response_to_anthropic(&openai_response);
                                let body_str = serde_json::to_string(&anthropic_response)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let mut response_builder = Response::builder()
                                    .status(StatusCode::OK)
                                    .header(hyper::header::CONTENT_TYPE, "application/json");
                                response_builder = add_cors_headers_with_host_and_origin(
                                    response_builder,
                                    &host_header,
                                    &origin_header,
                                    &config.trusted_hosts,
                                );
                                return Ok(response_builder.body(full(body_str)).unwrap());
                            }
                            Err(e) => {
                                let mut error_response =
                                    Response::builder().status(StatusCode::BAD_GATEWAY);
                                error_response = add_cors_headers_with_host_and_origin(
                                    error_response,
                                    &host_header,
                                    &origin_header,
                                    &config.trusted_hosts,
                                );
                                return Ok(error_response.body(full(e.message().to_string())).unwrap());
                            }
                        }
                    }

                    if let Some(model_id) = json_body.get("model").and_then(|v| v.as_str()) {
                        let pc = provider_configs.lock().await;

                        // Try to find a provider for this model
                        let provider_name: Option<String> = resolve_provider_name(&pc, model_id);

                        drop(pc);

                        if let Some(ref p) = provider_name {
                            log::info!("Using remote provider '{p}' for model '{model_id}'");
                            let pc2 = provider_configs.lock().await;
                            let provider_config = pc2.get(p.as_str()).cloned();
                            drop(pc2);

                            if let Some(provider_cfg) = provider_config {
                                plan.target_base_url = provider_cfg.base_url.clone().map(|url| {
                                    format!("{}{}", url.trim_end_matches('/'), "/messages")
                                });
                                plan.session_api_keys = provider_cfg.bearer_key_chain();
                                plan.provider_headers = custom_header_pairs(&provider_cfg);
                            }
                        } else {
                            let mlx_session_info = {
                                let mlx_guard = mlx_sessions.lock().await;
                                mlx_guard
                                    .values()
                                    .find(|s| model_ids_match(model_id, &s.info.model_id))
                                    .map(|s| s.info.clone())
                            };

                            if let Some(info) = mlx_session_info {
                                let target_port = info.port;
                                plan.session_api_keys = vec![info.api_key.clone()];
                                plan.mlx_model_id = Some(info.model_id.clone());
                                plan.target_base_url =
                                    Some(format!("http://127.0.0.1:{}/v1/messages", target_port));
                            } else if let Some((url, key)) =
                                engine_upstream(&llama_state, "/messages").await
                            {
                                plan.session_api_keys = vec![key];
                                plan.target_base_url = Some(url);
                            } else {
                                log::warn!("No running session found for model_id: {model_id}");
                                let mut error_response =
                                    Response::builder().status(StatusCode::NOT_FOUND);
                                error_response = add_cors_headers_with_host_and_origin(
                                    error_response,
                                    &host_header,
                                    &origin_header,
                                    &config.trusted_hosts,
                                );
                                return Ok(error_response
                                    .body(full(format!(
                                        "No running session found for model '{model_id}'"
                                    )))
                                    .unwrap());
                            }
                        }
                    } else {
                        let error_msg = "Request body must contain a 'model' field";
                        log::warn!("POST body for /messages missing 'model' field");
                        let mut error_response =
                            Response::builder().status(StatusCode::BAD_REQUEST);
                        error_response = add_cors_headers_with_host_and_origin(
                            error_response,
                            &host_header,
                            &origin_header,
                            &config.trusted_hosts,
                        );
                        return Ok(error_response.body(full(error_msg)).unwrap());
                    }
                }
                Err(e) => {
                    log::warn!("Failed to parse POST body for /messages as JSON: {e}");
                    let mut error_response = Response::builder().status(StatusCode::BAD_REQUEST);
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    let error_msg = format!("Invalid JSON body: {}", e);
                    return Ok(error_response.body(full(error_msg)).unwrap());
                }
            }
        }
        (hyper::Method::POST, "/orchestrations") => {
            // Headless orchestration endpoint:
            // - Load assistant system prompt + assistant model hint
            // - Ask the model for tool_calls
            // - Execute MCP tools server-side
            // - Feed tool results back and continue until completion
            log::info!(
                "Handling POST request to {destination_path} for assistant tool orchestration"
            );

            let body_bytes = match read_limited(body, max_api_body()).await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(body_error_response(
                        e,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    ));
                }
            };

            let json_body: serde_json::Value = match serde_json::from_slice(&body_bytes) {
                Ok(v) => v,
                Err(e) => {
                    let mut error_response = Response::builder().status(StatusCode::BAD_REQUEST);
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    return Ok(error_response
                        .body(full(format!("Invalid JSON body: {e}")))
                        .unwrap());
                }
            };

            let assistant_id = json_body
                .get("assistant_id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|v| v.to_string());

            let stream = json_body
                .get("stream")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if stream {
                let mut error_response = Response::builder().status(StatusCode::BAD_REQUEST);
                error_response = add_cors_headers_with_host_and_origin(
                    error_response,
                    &host_header,
                    &origin_header,
                    &config.trusted_hosts,
                );
                return Ok(error_response
                    .body(full("stream=true is not supported for /orchestrations"))
                    .unwrap());
            }

            let messages_value = match json_body.get("messages") {
                Some(v) => v,
                None => {
                    let mut error_response = Response::builder().status(StatusCode::BAD_REQUEST);
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    return Ok(error_response
                        .body(full("Missing required field 'messages'"))
                        .unwrap());
                }
            };

            let mut conversation_messages = match parse_openai_messages(messages_value) {
                Ok(msgs) => msgs,
                Err(e) => {
                    let mut error_response = Response::builder().status(StatusCode::BAD_REQUEST);
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    return Ok(error_response.body(full(e)).unwrap());
                }
            };
            // Self-heal a client-supplied conversation that has a tool_calls
            // turn missing one of its results -- some providers (notably
            // Anthropic) reject the entire request on a dangling tool_use.
            let repaired = repair_dangling_tool_calls(&mut conversation_messages);
            if repaired > 0 {
                log::warn!("proxy: repaired {repaired} dangling tool call(s) with no prior result");
            }

            // Load assistant config for system prompt + model hint when assistant_id is provided.
            let (assistant_instructions, assistant_model_hint) =
                if let Some(assistant_id) = assistant_id.as_deref() {
                    match load_assistant_config(&jan_data_folder, assistant_id) {
                        Ok(v) => v,
                        Err(e) => {
                            let mut error_response =
                                Response::builder().status(StatusCode::BAD_REQUEST);
                            error_response = add_cors_headers_with_host_and_origin(
                                error_response,
                                &host_header,
                                &origin_header,
                                &config.trusted_hosts,
                            );
                            return Ok(error_response.body(full(e)).unwrap());
                        }
                    }
                } else {
                    (None, None)
                };

            if let Some(sys) = assistant_instructions {
                replace_system_prompt(&mut conversation_messages, &sys);
            }

            // Resolve model to use for orchestration.
            let model_override = json_body.get("model").and_then(|v| v.as_str());
            let mut model_id: Option<String>;

            if let Some(ov) = model_override {
                model_id = Some(ov.to_string());
            } else if let Some(h) = assistant_model_hint {
                let trimmed = h.trim();
                if !trimmed.is_empty() && trimmed != "*" {
                    model_id = Some(trimmed.to_string());
                } else {
                    model_id = router_first_model(&llama_state, &local_client).await;
                    if model_id.is_none() {
                        let mlx_guard = mlx_sessions.lock().await;
                        model_id = mlx_guard.values().next().map(|s| s.info.model_id.clone());
                    }
                }
            } else {
                model_id = router_first_model(&llama_state, &local_client).await;
                if model_id.is_none() {
                    let mlx_guard = mlx_sessions.lock().await;
                    model_id = mlx_guard.values().next().map(|s| s.info.model_id.clone());
                }
            }

            let model_id = match model_id {
                Some(v) => v,
                None => {
                    let mut error_response = Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .header("Content-Type", "application/json")
                        .header("Retry-After", "1");
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    return Ok(error_response
                        .body(full(error_json(
                            "No running model sessions available",
                            "server_error",
                            "no_model_loaded",
                        )))
                        .unwrap());
                }
            };

            // Tool execution support (MCP only for now).
            let (openai_tools, tool_to_server, tool_call_names) =
                match collect_mcp_openai_tools(&mcp_servers, &mcp_settings).await {
                    Ok(v) => v,
                    Err(e) => {
                        let mut error_response =
                            Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR);
                        error_response = add_cors_headers_with_host_and_origin(
                            error_response,
                            &host_header,
                            &origin_header,
                            &config.trusted_hosts,
                        );
                        return Ok(error_response.body(full(e)).unwrap());
                    }
                };

            let (upstream_url, session_api_keys) = match resolve_upstream_for_model(
                &model_id,
                provider_configs.clone(),
                llama_state.clone(),
                mlx_sessions.clone(),
            )
            .await
            {
                Ok(v) => v,
                Err(e) => {
                    let mut error_response = Response::builder().status(StatusCode::NOT_FOUND);
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    return Ok(error_response.body(full(e)).unwrap());
                }
            };
            // `provider/model` records the provider qualifier used to resolve
            // the upstream above; the request body must carry the bare model id.
            let body_model_id = {
                let pc = provider_configs.lock().await;
                crate::core::agent::upstream::strip_provider_prefix(&model_id, &pc)
            };

            let max_turns = json_body
                .get("max_turns")
                .and_then(|v| v.as_u64())
                .unwrap_or(8)
                .clamp(1, 20) as usize;

            let mut last_response: Option<serde_json::Value> = None;

            for _turn in 0..max_turns {
                // Build upstream request body for each turn so messages are updated.
                let mut completion_map = serde_json::Map::new();
                completion_map.insert("model".to_string(), serde_json::json!(body_model_id));
                completion_map.insert(
                    "messages".to_string(),
                    serde_json::Value::Array(conversation_messages.clone()),
                );
                completion_map.insert("stream".to_string(), serde_json::json!(false));
                completion_map.insert("tool_choice".to_string(), serde_json::json!("auto"));

                if !openai_tools.is_empty() {
                    completion_map.insert(
                        "tools".to_string(),
                        serde_json::Value::Array(openai_tools.clone()),
                    );
                }

                copy_optional_chat_params(&json_body, &mut completion_map);

                let request_value = serde_json::Value::Object(completion_map);

                let completion = match call_openai_chat_completions(
                    if is_local_url(&upstream_url) { &local_client } else { &client },
                    &upstream_url,
                    &session_api_keys,
                    &request_value,
                )
                .await
                {
                    Ok(v) => v,
                    Err(e) => {
                        let mut error_response =
                            Response::builder().status(StatusCode::BAD_GATEWAY);
                        error_response = add_cors_headers_with_host_and_origin(
                            error_response,
                            &host_header,
                            &origin_header,
                            &config.trusted_hosts,
                        );
                        return Ok(error_response.body(full(e)).unwrap());
                    }
                };

                let tool_calls = extract_tool_calls(&completion);
                last_response = Some(completion.clone());

                if tool_calls.is_empty() {
                    let body_str =
                        serde_json::to_string(&completion).unwrap_or_else(|_| "{}".to_string());
                    let mut response_builder = Response::builder()
                        .status(StatusCode::OK)
                        .header(hyper::header::CONTENT_TYPE, "application/json");
                    response_builder = add_cors_headers_with_host_and_origin(
                        response_builder,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    return Ok(response_builder.body(full(body_str)).unwrap());
                }

                // Append assistant tool call message, then execute tool calls.
                if let Some(choice_message) = extract_choice_message(&completion) {
                    let assistant_content = choice_message
                        .get("content")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    conversation_messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": assistant_content,
                        "tool_calls": tool_calls.clone()
                    }));
                } else {
                    conversation_messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": serde_json::Value::Null,
                        "tool_calls": tool_calls.clone()
                    }));
                }

                let tool_results = execute_mcp_tool_calls(
                    &tool_calls,
                    &tool_to_server,
                    &tool_call_names,
                    &mcp_servers,
                    &mcp_settings,
                )
                .await;

                for (tool_call_id, result_text) in tool_results {
                    conversation_messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result_text
                    }));
                }
            }

            // Safety catch: model kept requesting tools beyond max_turns.
            let body_json = last_response.unwrap_or_else(|| serde_json::json!({}));
            let body_str = serde_json::to_string(&body_json).unwrap_or_else(|_| "{}".to_string());
            let mut error_response = Response::builder().status(StatusCode::UNPROCESSABLE_ENTITY);
            error_response = add_cors_headers_with_host_and_origin(
                error_response,
                &host_header,
                &origin_header,
                &config.trusted_hosts,
            );
            let payload = format!(
                "{{\"error\":\"max_turns reached while resolving tool calls\",\"last_response\":{body_str}}}"
            );
            let response = error_response.body(full(payload)).unwrap();
            return Ok(response);
        }
        (hyper::Method::POST, "/chat/completions")
        | (hyper::Method::POST, "/completions")
        | (hyper::Method::POST, "/embeddings")
        | (hyper::Method::POST, "/messages/count_tokens") => {
            log::info!(
                "Handling POST request to {destination_path} requiring model lookup in body",
            );
            let body_bytes = match read_limited(body, max_api_body()).await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(body_error_response(
                        e,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    ));
                }
            };
            plan.buffered_body = Some(body_bytes.clone());

            match serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                Ok(mut json_body) => {
                    // Work around strict JSON-schema converters that reject property schemas
                    // of the form `{ "description": "..." }` (missing `type`).
                    // This happens for OpenAI-style tool schemas used with /chat/completions.
                    if destination_path == "/chat/completions" {
                        normalize_openai_tools_in_chat_body(&mut json_body);
                    }
                    // Strip Claude Code's billing header from chat/token-count
                    // bodies too (it lands in the first message content here).
                    strip_billing_header_in_body(&mut json_body);
                    if let Ok(cleaned) = serde_json::to_vec(&json_body) {
                        plan.buffered_body = Some(cleaned.into());
                    }

                    if config.enable_server_tool_execution
                        && destination_path == "/chat/completions"
                        && !json_body
                            .get("stream")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                    {
                        match run_server_side_openai_orchestration(
                            &json_body,
                            &crate::core::agent::upstream::agent_http_client(),
                            provider_configs.clone(),
                            llama_state.clone(),
                            mlx_sessions.clone(),
                            mcp_servers.clone(),
                            mcp_settings.clone(),
                            &jan_data_folder,
                        )
                        .await
                        {
                            Ok(openai_response) => {
                                let body_str = serde_json::to_string(&openai_response)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let mut response_builder = Response::builder()
                                    .status(StatusCode::OK)
                                    .header(hyper::header::CONTENT_TYPE, "application/json");
                                response_builder = add_cors_headers_with_host_and_origin(
                                    response_builder,
                                    &host_header,
                                    &origin_header,
                                    &config.trusted_hosts,
                                );
                                return Ok(response_builder.body(full(body_str)).unwrap());
                            }
                            Err(e) => {
                                let mut error_response =
                                    Response::builder().status(StatusCode::BAD_GATEWAY);
                                error_response = add_cors_headers_with_host_and_origin(
                                    error_response,
                                    &host_header,
                                    &origin_header,
                                    &config.trusted_hosts,
                                );
                                return Ok(error_response.body(full(e.message().to_string())).unwrap());
                            }
                        }
                    }

                    if let Some(model_id) = json_body.get("model").and_then(|v| v.as_str()) {
                        log::debug!("Extracted model_id: {model_id}");

                        // First, check if there's a registered remote provider for this model
                        let pc = provider_configs.lock().await;

                        // Try to find a provider that has this model configured
                        let provider_name = resolve_provider_name(&pc, model_id);

                        drop(pc);

                        if let Some(ref provider) = provider_name {
                            // Found a remote provider, stream the response directly
                            log::info!("Found remote provider '{provider}' for model '{model_id}'");

                            // Get the provider config
                            let pc2 = provider_configs.lock().await;
                            let provider_config = pc2.get(provider.as_str()).cloned();

                            // Log registered providers for debugging
                            log::debug!(
                                "Registered providers: {:?}",
                                pc2.keys().collect::<Vec<_>>()
                            );

                            drop(pc2);

                            if let Some(provider_cfg) = provider_config {
                                // A converter only applies to chat/completions; other
                                // paths keep verbatim forwarding.
                                let converter = if destination_path == "/chat/completions" {
                                    converter_for(provider_cfg.api_type.as_deref())
                                } else {
                                    None
                                };
                                if let Some(api_url) = provider_cfg.base_url.clone() {
                                    let path = converter
                                        .as_ref()
                                        .map(|c| c.upstream_path(&json_body))
                                        .unwrap_or_else(|| destination_path.clone());
                                    plan.target_base_url = Some(format!("{api_url}{path}"));
                                } else {
                                    plan.target_base_url = None;
                                }
                                plan.upstream_converter = converter;
                                plan.session_api_keys = provider_cfg.bearer_key_chain();
                                plan.provider_headers = custom_header_pairs(&provider_cfg);
                            } else {
                                log::error!("Provider config not found for '{provider}'");
                            }
                        } else {
                            let sessions_find_model = model_id;

                            let mlx_session_info = {
                                let mlx_guard = mlx_sessions.lock().await;
                                mlx_guard
                                    .values()
                                    .find(|s| model_ids_match(sessions_find_model, &s.info.model_id))
                                    .map(|s| s.info.clone())
                            };

                            let router_up = engine_upstream(&llama_state, &destination_path).await;

                            if mlx_session_info.is_none() && router_up.is_none() {
                                log::warn!(
                                    "Request for model '{model_id}' but no models are running."
                                );
                                let mut error_response = Response::builder()
                                    .status(StatusCode::SERVICE_UNAVAILABLE)
                                    .header("Content-Type", "application/json")
                                    .header("Retry-After", "1");
                                error_response = add_cors_headers_with_host_and_origin(
                                    error_response,
                                    &host_header,
                                    &origin_header,
                                    &config.trusted_hosts,
                                );
                                return Ok(error_response
                                    .body(full(error_json(
                                        "No models are available",
                                        "server_error",
                                        "no_model_loaded",
                                    )))
                                    .unwrap());
                            }

                            if let Some(info) = mlx_session_info {
                                let target_port = info.port;
                                plan.session_api_keys = vec![info.api_key.clone()];
                                plan.mlx_model_id = Some(info.model_id.clone());
                                log::debug!("Found MLX session for model_id {model_id}");
                                plan.target_base_url = Some(format!(
                                    "http://127.0.0.1:{target_port}/v1{destination_path}"
                                ));
                            } else if let Some((url, key)) = router_up {
                                log::debug!("Routing model_id {model_id} via llamacpp router");
                                plan.engine_model_id = Some(model_id.to_string());
                                plan.session_api_keys = vec![key];
                                plan.target_base_url = Some(url);
                            } else {
                                log::warn!("No running session found for model_id: {model_id}");
                                let mut error_response =
                                    Response::builder().status(StatusCode::NOT_FOUND);
                                error_response = add_cors_headers_with_host_and_origin(
                                    error_response,
                                    &host_header,
                                    &origin_header,
                                    &config.trusted_hosts,
                                );
                                return Ok(error_response
                                    .body(full(format!(
                                        "No running session found for model '{model_id}'"
                                    )))
                                    .unwrap());
                            }
                        }
                    } else {
                        let error_msg = "Request body must contain a 'model' field";
                        log::warn!(
                            "POST body for {destination_path} is missing 'model' field or it's not a string"
                        );
                        let mut error_response =
                            Response::builder().status(StatusCode::BAD_REQUEST);
                        error_response = add_cors_headers_with_host_and_origin(
                            error_response,
                            &host_header,
                            &origin_header,
                            &config.trusted_hosts,
                        );
                        return Ok(error_response.body(full(error_msg)).unwrap());
                    }
                }
                Err(e) => {
                    log::warn!("Failed to parse POST body for {destination_path} as JSON: {e}");
                    let mut error_response = Response::builder().status(StatusCode::BAD_REQUEST);
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    let error_msg = format!("Invalid JSON body: {}", e);
                    return Ok(error_response.body(full(error_msg)).unwrap());
                }
            }
        }
        (hyper::Method::POST, "/images/generations") => {
            let body_bytes = match read_limited(body, max_api_body()).await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(body_error_response(e, &host_header, &origin_header, &config.trusted_hosts));
                }
            };
            let (status, payload) = match serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                Ok(json) => match super::images_route::generate(&json).await {
                    Ok(done) => (StatusCode::OK, done),
                    Err(e) => (
                        StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                        e.body(),
                    ),
                },
                Err(_) => (
                    StatusCode::BAD_REQUEST,
                    super::images_route::ApiError {
                        status: 400,
                        message: "The request body must be JSON.".into(),
                        param: Some("body"),
                        code: "invalid_request",
                    }
                    .body(),
                ),
            };
            let mut builder = Response::builder()
                .status(status)
                .header(hyper::header::CONTENT_TYPE, "application/json");
            builder = add_cors_headers_with_host_and_origin(
                builder,
                &host_header,
                &origin_header,
                &config.trusted_hosts,
            );
            return Ok(builder.body(full(payload.to_string())).unwrap());
        }

        (hyper::Method::POST, "/videos") => {
            let body_bytes = match read_limited(body, max_api_body()).await {
                Ok(b) => b,
                Err(e) => {
                    return Ok(body_error_response(e, &host_header, &origin_header, &config.trusted_hosts));
                }
            };
            let outcome = match serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                Ok(json) => super::images_route::create_video(&json).await,
                Err(_) => Err(super::images_route::ApiError {
                    status: 400,
                    message: "The request body must be JSON.".into(),
                    param: Some("body"),
                    code: "invalid_request",
                }),
            };
            return Ok(json_response(outcome, &host_header, &origin_header, &config));
        }

        (hyper::Method::GET, video_path) if video_path.starts_with("/videos/") => {
            let rest = &video_path["/videos/".len()..];
            if let Some(id) = rest.strip_suffix("/content") {
                return Ok(match super::images_route::video_content(id).await {
                    Ok(bytes) => {
                        let mut builder = Response::builder()
                            .status(StatusCode::OK)
                            .header(hyper::header::CONTENT_TYPE, "video/webm");
                        builder = add_cors_headers_with_host_and_origin(
                            builder,
                            &host_header,
                            &origin_header,
                            &config.trusted_hosts,
                        );
                        builder.body(full(bytes)).unwrap()
                    }
                    Err(e) => json_response(Err(e), &host_header, &origin_header, &config),
                });
            }
            return Ok(json_response(
                super::images_route::get_video(rest),
                &host_header,
                &origin_header,
                &config,
            ));
        }

        (hyper::Method::GET, "/models") => {
            log::debug!("Handling GET /v1/models request");

            let preset_ini = std::fs::read_to_string(
                std::path::Path::new(&jan_data_folder)
                    .join("llamacpp")
                    .join("router.preset.ini"),
            )
            .unwrap_or_default();
            let local_models: Vec<_> = engine_list_model_entries(&llama_state, &local_client)
                .await
                .into_iter()
                .map(|(id, context)| {
                    // An unloaded model has no engine-reported window; fall
                    // back to the configured one rather than let clients guess.
                    let context =
                        context.or_else(|| preset_context_length(&preset_ini, &id));
                    let mut model = serde_json::json!({
                        "id": id,
                        "object": "model",
                        "created": 1,
                        "owned_by": "llama.cpp"
                    });
                    // IDE clients (Kilo Code, Cline) size their prompts from
                    // these; only set when the engine reported a window.
                    if let Some(context) = context {
                        model["context_length"] = context.into();
                        model["max_model_len"] = context.into();
                    }
                    model
                })
                .collect();

            // Get MLX sessions
            let mlx_models: Vec<_> = {
                let mlx_guard = mlx_sessions.lock().await;
                mlx_guard
                    .values()
                    .map(|session| {
                        serde_json::json!({
                            "id": session.info.model_id,
                            "object": "model",
                            "created": 1,
                            "owned_by": "mlx"
                        })
                    })
                    .collect()
            };

            // Get remote provider models
            let pc = provider_configs.lock().await;
            let remote_models: Vec<_> = pc
                .values()
                .flat_map(|provider_cfg| provider_cfg.models.clone())
                .map(|model_id| {
                    serde_json::json!({
                        "id": model_id,
                        "object": "model",
                        "created": 1,
                        "owned_by": "remote"
                    })
                })
                .collect();

            // Store counts before moving
            let local_count = local_models.len();
            let mlx_count = mlx_models.len();
            let remote_count = remote_models.len();

            // Combine all models
            let mut all_models = Vec::with_capacity(local_count + mlx_count + remote_count);
            all_models.extend(local_models);
            all_models.extend(mlx_models);
            all_models.extend(remote_models);

            let response_json = serde_json::json!({
                "object": "list",
                "data": all_models
            });

            let body_str =
                serde_json::to_string(&response_json).unwrap_or_else(|_| "{}".to_string());

            let mut response_builder = Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "application/json");

            response_builder = add_cors_headers_with_host_and_origin(
                response_builder,
                &host_header,
                &origin_header,
                &config.trusted_hosts,
            );

            log::debug!(
                "Returning {} models ({} llama.cpp, {} MLX, {} remote)",
                all_models.len(),
                local_count,
                mlx_count,
                remote_count
            );

            return Ok(response_builder.body(full(body_str)).unwrap());
        }

        (hyper::Method::GET, "/openapi.json") => {
            let static_body = include_str!("../../../static/openapi.json"); // relative to src-tauri/src/
                                                                            // Parse the static OpenAPI JSON and update the server URL with actual host and port
            match serde_json::from_str::<serde_json::Value>(static_body) {
                Ok(mut openapi_spec) => {
                    // Update the servers array with the actual host and port
                    if let Some(servers) = openapi_spec
                        .get_mut("servers")
                        .and_then(|s| s.as_array_mut())
                    {
                        for server in servers {
                            if let Some(server_obj) = server.as_object_mut() {
                                if let Some(url) = server_obj.get_mut("url") {
                                    let base_url = format!(
                                        "http://{}:{}{}",
                                        config.host, config.port, config.prefix
                                    );
                                    *url = serde_json::Value::String(base_url);
                                }
                            }
                        }
                    }
                    let body = serde_json::to_string(&openapi_spec)
                        .unwrap_or_else(|_| static_body.to_string());
                    return Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header(hyper::header::CONTENT_TYPE, "application/json")
                        .body(full(body))
                        .unwrap());
                }
                Err(_) => {
                    // If parsing fails, return the static file as fallback
                    return Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header(hyper::header::CONTENT_TYPE, "application/json")
                        .body(full(static_body))
                        .unwrap());
                }
            }
        }

        // DOCS route
        (hyper::Method::GET, "/") => {
            let html = r#"
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>API Docs</title>
  <link rel="stylesheet" type="text/css" href="/docs/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js"></script>
  <script>
  window.onload = () => {
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
    });
  };
  </script>
</body>
</html>
    "#;

            let mut response_builder = Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "text/html");

            response_builder = add_cors_headers_with_host_and_origin(
                response_builder,
                &host_header,
                &origin_header,
                &config.trusted_hosts,
            );

            return Ok(response_builder.body(full(html)).unwrap());
        }

        (hyper::Method::GET, "/docs/swagger-ui.css") => {
            let css = include_str!("../../../static/swagger-ui/swagger-ui.css");
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "text/css")
                .body(full(css))
                .unwrap());
        }

        (hyper::Method::GET, "/docs/swagger-ui-bundle.js") => {
            let js = include_str!("../../../static/swagger-ui/swagger-ui-bundle.js");
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "application/javascript")
                .body(full(js))
                .unwrap());
        }

        (hyper::Method::GET, "/favicon.ico") => {
            let icon = include_bytes!("../../../static/swagger-ui/favicon.ico");
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "image/x-icon")
                .body(full(icon.as_ref()))
                .unwrap());
        }

        _ => {
            let is_explicitly_whitelisted_get = method == hyper::Method::GET
                && WHITELISTED_PATHS.contains(&destination_path.as_str());
            if is_explicitly_whitelisted_get {
                log::debug!("Handled whitelisted GET path: {destination_path}");
                let mut error_response = Response::builder().status(StatusCode::NOT_FOUND);
                error_response = add_cors_headers_with_host_and_origin(
                    error_response,
                    &host_header,
                    &origin_header,
                    &config.trusted_hosts,
                );
                return Ok(error_response.body(full("Not Found")).unwrap());
            } else {
                log::warn!(
                    "Unhandled method/path for dynamic routing: {method} {destination_path}"
                );
                let mut error_response = Response::builder().status(StatusCode::NOT_FOUND);
                error_response = add_cors_headers_with_host_and_origin(
                    error_response,
                    &host_header,
                    &origin_header,
                    &config.trusted_hosts,
                );
                return Ok(error_response.body(full("Not Found")).unwrap());
            }
        }
    }

    let upstream_url = match plan.target_base_url.clone() {
        Some(p) => p,
        None => {
            log::error!(
                "Internal API server routing error: target is None after successful lookup"
            );
            let mut error_response = Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR);
            error_response = add_cors_headers_with_host_and_origin(
                error_response,
                &host_header,
                &origin_header,
                &config.trusted_hosts,
            );
            return Ok(error_response.body(full("Internal routing error")).unwrap());
        }
    };
    log::info!(
        "Proxying request to model server at base URL {upstream_url}, path: {destination_path}"
    );

    let mut body_bytes_for_proxy = match plan.buffered_body.clone() {
        Some(b) => b,
        None => {
            log::error!(
                "Internal logic error: Request reached proxy stage without a buffered body."
            );
            let mut error_response = Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR);
            error_response = add_cors_headers_with_host_and_origin(
                error_response,
                &host_header,
                &origin_header,
                &config.trusted_hosts,
            );
            return Ok(error_response
                .body(full("Internal server error: unhandled request path"))
                .unwrap());
        }
    };

    // Rewrite the chat/completions body into the provider's native request shape.
    if let Some(converter) = &plan.upstream_converter {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body_bytes_for_proxy) {
            let native = converter.convert_request(&v);
            if let Ok(bytes) = serde_json::to_vec(&native) {
                body_bytes_for_proxy = Bytes::from(bytes);
            }
        }
    }

    // MLX targets carry no router preset, so apply the model's stored sampling
    // defaults here for keys the caller omitted (llamacpp uses the preset;
    // remote providers are intentionally left untouched).
    if let Some(mid) = &plan.mlx_model_id {
        let defaults = {
            let guard = model_param_defaults.lock().await;
            guard.get(mid).cloned()
        };
        if let Some(defaults) = defaults {
            if let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&body_bytes_for_proxy) {
                inject_sampling_defaults(&mut v, &defaults);
                if let Ok(bytes) = serde_json::to_vec(&v) {
                    body_bytes_for_proxy = Bytes::from(bytes);
                }
            }
        }
    }

    let key_attempts: Vec<Option<String>> = if plan.session_api_keys.is_empty() {
        vec![None]
    } else {
        plan.session_api_keys.iter().cloned().map(Some).collect()
    };

    // For Anthropic /messages, we need to track if we should transform the response
    let destination_path = path.clone();

    for (key_idx, key_opt) in key_attempts.iter().enumerate() {
        let outbound_client = if is_local_url(&upstream_url) { &local_client } else { &client };
        let mut outbound_req = outbound_client.request(method.clone(), upstream_url.clone());

        // Body is re-buffered/rewritten, so a stale inbound Content-Length would
        // mismatch the bytes we send and stall the upstream; reqwest re-derives it.
        for (name, value) in headers.iter() {
            if forwards_to_upstream(name) {
                outbound_req = outbound_req.header(name, value);
            }
        }

        if let Some(key) = key_opt {
            // The converter decides the auth scheme (Google uses x-goog-api-key).
            let (auth_name, auth_value) = match &plan.upstream_converter {
                Some(conv) => conv.auth_header(key),
                None => ("authorization", format!("Bearer {key}")),
            };
            outbound_req = outbound_req.header(auth_name, auth_value);
            if let Some(conv) = &plan.upstream_converter {
                for (name, value) in conv.credential_headers(key) {
                    outbound_req = outbound_req.header(name, value);
                }
            }
        } else {
            log::debug!("No session API key for this attempt");
        }

        for (name, value) in &plan.provider_headers {
            outbound_req = outbound_req.header(name.as_str(), value.as_str());
        }

        // Fixed headers the native API requires (Anthropic: anthropic-version).
        if let Some(conv) = &plan.upstream_converter {
            for (name, value) in conv.extra_headers() {
                outbound_req = outbound_req.header(name, value);
            }
        }

        let outbound_req_with_body = outbound_req.body(body_bytes_for_proxy.clone());

        match outbound_req_with_body.send().await {
            Ok(response) => {
                let status = response.status();

                let is_error = !status.is_success();

                if is_error
                    && http_status_indicates_api_key_retry(status)
                    && key_idx + 1 < key_attempts.len()
                {
                    let _ = response.text().await;
                    log::warn!("Upstream {status} for API key index {key_idx}, trying next key");
                    continue;
                }

                // For Anthropic /messages requests with errors, try /chat/completions
                if is_error && plan.is_anthropic_messages {
                    log::warn!("Request failed for /messages with status {status}, trying /chat/completions...");

                    // Read the error body to return to client if fallback fails
                    let error_body = response
                        .text()
                        .await
                        .unwrap_or_else(|e| format!("Failed to read error body: {}", e));

                    // Clone what we need for the fallback request
                    let fallback_url = plan.target_base_url.clone().map(|url| {
                        url.trim_end_matches("/messages")
                            .trim_end_matches('/')
                            .to_string()
                    });
                    let fallback_api_key = key_opt.clone();
                    let fallback_body = Some(body_bytes_for_proxy.clone());

                    // Transform body to OpenAI format for fallback
                    if let Some((url, openai_body)) = fallback_url.zip(fallback_body).and_then(|(url, body)| {
                    let json_body = serde_json::from_slice::<serde_json::Value>(&body).ok()?;
                    match transform_anthropic_to_openai(&json_body) {
                        Some(transformed) => Some((url, transformed)),
                        None => {
                            log::error!(
                                "transform_anthropic_to_openai returned None (keys: {:?}, messages: {}, bytes: {})",
                                json_body.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                                json_body.get("messages").and_then(|m| m.as_array()).map_or(0, |m| m.len()),
                                body.len()
                            );
                            None
                        }
                    }
                }) {
                    let chat_url = format!("{}/chat/completions", url);
                    log::info!("Fallback to chat completions: {chat_url}");

                    // The shared clients carry the connect and read timeouts.
                    let fallback_client = if is_local_url(&chat_url) { &local_client } else { &client };

                    let mut fallback_req = fallback_client.post(&chat_url);

                    // Ensure Content-Type is set and prevent compression
                    fallback_req = fallback_req.header("Content-Type", "application/json");
                    fallback_req = fallback_req.header("Accept-Encoding", "identity");

                    for (name, value) in headers.iter() {
                        if forwards_to_upstream(name)
                            && name != "content-type"
                            && name != hyper::header::ACCEPT_ENCODING
                        {
                            fallback_req = fallback_req.header(name, value);
                        }
                    }
                    for (name, value) in &plan.provider_headers {
                        fallback_req = fallback_req.header(name.as_str(), value.as_str());
                    }
                    if let Some(key) = fallback_api_key {
                        fallback_req = fallback_req.header("Authorization", format!("Bearer {key}"));
                    }

                    let fallback_body_str = openai_body.to_string();

                    let fallback_response = fallback_req.body(fallback_body_str).send().await;

                    if let Ok(res) = fallback_response {
                        let fallback_status = res.status();

                        if !fallback_status.is_success() {
                            // Return fallback error to client
                            let fallback_error = res.text().await.unwrap_or_else(|e| format!("Failed to read error: {}", e));

                            let fallback_error = anthropic_context_error(&fallback_error)
                                .unwrap_or(fallback_error);
                            // Return the error to client
                            let mut error_response = Response::builder().status(fallback_status);
                            error_response = add_cors_headers_with_host_and_origin(
                                error_response,
                                &host_header,
                                &origin_header,
                                &config.trusted_hosts,
                            );
                            return Ok(error_response
                                .body(full(fallback_error))
                                .unwrap());
                        }

                        let mut builder = Response::builder().status(fallback_status);
                        for (name, value) in res.headers() {
                            if !is_cors_header(name.as_str()) && name != hyper::header::CONTENT_LENGTH {
                                builder = builder.header(name, value);
                            }
                        }
                        builder = add_cors_headers_with_host_and_origin(
                            builder,
                            &host_header,
                            &origin_header,
                            &config.trusted_hosts,
                        );

                        let is_streaming = openai_body
                            .get("stream")
                            .and_then(|s| s.as_bool())
                            .unwrap_or(false);

                        let (sender, body) = body_channel();
                        let dest_path = destination_path.clone();
                        let meter_model = meter_model_of(metered, &body_bytes_for_proxy);
                        let meter_folder = jan_data_folder.clone();

                        tokio::spawn(async move {
                            let tap = SharedTap::default();
                            if is_streaming {
                                let stream = tapped(res.bytes_stream(), &tap, meter_model.is_some());
                                transform_and_forward_stream(stream, sender, &dest_path).await;
                            } else {
                                let response_body = res.bytes().await;
                                if let (Some(_), Ok(b)) = (&meter_model, &response_body) {
                                    lock_tap(&tap).push(b);
                                }
                                forward_non_streaming(
                                    response_body,
                                    sender,
                                    &dest_path,
                                )
                                .await;
                            }
                            finish_meter(meter_model, &meter_folder, &tap);
                        });

                        return Ok(builder.body(body).unwrap());
                    } else if let Err(ref err) = fallback_response {
                        log::error!("Chat completions fallback failed: {}", err);
                        return Ok(fallback_failure_response(
                            &err.to_string(),
                            &host_header,
                            &origin_header,
                            &config.trusted_hosts,
                        ));
                    }
                }

                    // If fallback failed or wasn't attempted, return error to client
                    let error_body = anthropic_context_error(&error_body).unwrap_or(error_body);
                    let mut error_response = Response::builder().status(status);
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    return Ok(error_response.body(full(error_body)).unwrap());
                } else if is_error {
                    // Non-/messages error - return error response with body
                    let error_body = response
                        .text()
                        .await
                        .unwrap_or_else(|e| format!("Failed to read error body: {}", e));

                    let mut error_response = Response::builder().status(status);
                    error_response = add_cors_headers_with_host_and_origin(
                        error_response,
                        &host_header,
                        &origin_header,
                        &config.trusted_hosts,
                    );
                    return Ok(error_response.body(full(error_body)).unwrap());
                }

                // Success case - stream the response
                let mut builder = Response::builder().status(status);

                for (name, value) in response.headers() {
                    if !is_cors_header(name.as_str()) && name != hyper::header::CONTENT_LENGTH {
                        builder = builder.header(name, value);
                    }
                }
                if metered {
                    if let Some(room) =
                        super::usage_meter::headroom(std::path::Path::new(&jan_data_folder))
                    {
                        for (name, value) in room.headers() {
                            builder = builder.header(name, value);
                        }
                    }
                }

                builder = add_cors_headers_with_host_and_origin(
                    builder,
                    &host_header,
                    &origin_header,
                    &config.trusted_hosts,
                );

                // When the provider fronts a non-chat/completions API, translate the
                // response back to chat shape; otherwise forward bytes verbatim.
                if let Some(converter) = plan.upstream_converter.take() {
                    let is_sse = response
                        .headers()
                        .get(hyper::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .map(|ct| ct.contains("event-stream"))
                        .unwrap_or(false);
                    let (sender, body) = body_channel();
                    let meter_model = meter_model_of(metered, &body_bytes_for_proxy);
                    let meter_folder = jan_data_folder.clone();
                    tokio::spawn(async move {
                        let tap = SharedTap::default();
                        if is_sse {
                            let stream = tapped(response.bytes_stream(), &tap, meter_model.is_some());
                            forward_converted_stream(stream, sender, converter).await;
                        } else {
                            let bytes = response.bytes().await;
                            if let (Some(_), Ok(b)) = (&meter_model, &bytes) {
                                lock_tap(&tap).push(b);
                            }
                            forward_converted_non_streaming(bytes, sender, converter).await;
                        }
                        finish_meter(meter_model, &meter_folder, &tap);
                    });
                    return Ok(builder.body(body).unwrap());
                }

                let mut stream = response.bytes_stream();
                let (mut sender, body) = body_channel();
                let meter_model = metered
                    .then(|| {
                        serde_json::from_slice::<serde_json::Value>(&body_bytes_for_proxy)
                            .ok()
                            .and_then(|v| v.get("model").and_then(|m| m.as_str().map(String::from)))
                    })
                    .flatten();
                let meter_folder = jan_data_folder.clone();

                let mut model_rewriter = plan.engine_model_id.take().map(ModelFieldRewriter::new);
                tokio::spawn(async move {
                    let mut tap = super::usage_meter::UsageTap::default();
                    // Regular passthrough - when /messages succeeds directly,
                    // the response is already in the correct format
                    while let Some(chunk_result) = stream.next().await {
                        match chunk_result {
                            Ok(chunk) => {
                                if meter_model.is_some() {
                                    tap.push(&chunk);
                                }
                                let chunk = match model_rewriter.as_mut() {
                                    Some(r) => r.push(&chunk),
                                    None => chunk,
                                };
                                if !chunk.is_empty() && sender.send_data(chunk).await.is_err() {
                                    log::debug!("Client disconnected during streaming");
                                    break;
                                }
                            }
                            Err(e) => {
                                log::error!("Stream error: {e}");
                                break;
                            }
                        }
                    }
                    if let Some(rest) = model_rewriter.as_mut().map(|r| r.finish()) {
                        if !rest.is_empty() {
                            let _ = sender.send_data(rest).await;
                        }
                    }
                    log::debug!("Streaming complete to client");
                    if let (Some(model), Some((input, output))) = (meter_model, tap.counts()) {
                        super::usage_meter::record(
                            std::path::Path::new(&meter_folder),
                            &model,
                            input,
                            output,
                        );
                        super::usage_meter::forget();
                    }
                });

                return Ok(builder.body(body).unwrap());
            }
            Err(e) => {
                let error_msg = format!("Proxy request to model failed: {e}");
                log::error!("{error_msg}");
                // A local engine that is not answering is worth retrying; a
                // remote provider that is unreachable is a bad gateway.
                let local = is_local_url(upstream_url.as_str());
                let mut error_response = Response::builder()
                    .status(if local {
                        StatusCode::SERVICE_UNAVAILABLE
                    } else {
                        StatusCode::BAD_GATEWAY
                    })
                    .header("Content-Type", "application/json");
                if local {
                    error_response = error_response.header("Retry-After", "1");
                }
                error_response = add_cors_headers_with_host_and_origin(
                    error_response,
                    &host_header,
                    &origin_header,
                    &config.trusted_hosts,
                );
                return Ok(error_response
                    .body(full(error_json(
                        &error_msg,
                        "server_error",
                        if local {
                            "backend_unavailable"
                        } else {
                            "upstream_unreachable"
                        },
                    )))
                    .unwrap());
            }
        }
    }

    log::error!("Internal error: proxy key loop exited without a response");
    let mut error_response = Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR);
    error_response = add_cors_headers_with_host_and_origin(
        error_response,
        &host_header,
        &origin_header,
        &config.trusted_hosts,
    );
    Ok(error_response.body(full("Internal proxy error")).unwrap())
}

/// Gives an engine response the model id the request named.
///
/// llama.cpp answers with the model's absolute file path in `model`
/// (`C:\models\gemma-3-4b-it-Q4_K_M.gguf`), which leaks a local path and is not
/// the id a client asked for or can send back (T7-080). Lines are rewritten
/// whole, so a chunk boundary in the middle of an SSE event or a JSON body is
/// held until the line ends (or the response does).
pub(crate) struct ModelFieldRewriter {
    id: String,
    pending: Vec<u8>,
}

impl ModelFieldRewriter {
    pub(crate) fn new(id: String) -> Self {
        Self { id, pending: Vec::new() }
    }

    /// Complete lines of `chunk` (plus anything held over), rewritten.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Bytes {
        self.pending.extend_from_slice(chunk);
        let Some(last_nl) = self.pending.iter().rposition(|b| *b == b'\n') else {
            return Bytes::new();
        };
        let rest = self.pending.split_off(last_nl + 1);
        let ready = std::mem::replace(&mut self.pending, rest);
        let mut out = Vec::with_capacity(ready.len());
        for line in ready.split_inclusive(|b| *b == b'\n') {
            out.extend_from_slice(&rewrite_model_line(line, &self.id));
        }
        Bytes::from(out)
    }

    /// Whatever is left once the response ends (a JSON body with no newline).
    pub(crate) fn finish(&mut self) -> Bytes {
        let rest = std::mem::take(&mut self.pending);
        Bytes::from(rewrite_model_line(&rest, &self.id))
    }
}

/// One line (`data: {..}` or a bare JSON body), with a path-like `model`
/// replaced by `id`. Anything else comes back unchanged.
fn rewrite_model_line(line: &[u8], id: &str) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(line) else {
        return line.to_vec();
    };
    let body_end = text.trim_end_matches(['\r', '\n']).len();
    let (head, json) = match text[..body_end].strip_prefix("data: ") {
        Some(rest) => ("data: ", rest),
        None => ("", &text[..body_end]),
    };
    if !json.trim_start().starts_with('{') || !json.contains("\"model\"") {
        return line.to_vec();
    }
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(json) else {
        return line.to_vec();
    };
    let is_path =
        |m: &str| m.contains('/') || m.contains('\\') || m.to_ascii_lowercase().ends_with(".gguf");
    match value.get("model").and_then(|m| m.as_str()) {
        Some(m) if m != id && is_path(m) => {}
        _ => return line.to_vec(),
    }
    value["model"] = serde_json::Value::String(id.to_string());
    let Ok(rewritten) = serde_json::to_string(&value) else {
        return line.to_vec();
    };
    format!("{head}{rewritten}{}", &text[body_end..]).into_bytes()
}

/// True when this bind exposes the API to the network with no authentication:
/// a non-loopback host and an empty API key.
fn is_insecure_public_bind(host: &str, api_key: &str) -> bool {
    !is_loopback_host(host) && api_key.is_empty()
}

/// True for `localhost` and any loopback IP literal, bracketed or not,
/// including IPv4-mapped IPv6 loopback.
fn is_loopback_host(host: &str) -> bool {
    let bare = host.trim().trim_start_matches('[').trim_end_matches(']');
    if bare.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback(),
        Ok(std::net::IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        Err(_) => false,
    }
}

/// Socket address for `host:port`, accepting bare or bracketed IPv6 literals
/// and `localhost`.
fn bind_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    let bare = host.trim().trim_start_matches('[').trim_end_matches(']');
    if bare.eq_ignore_ascii_case("localhost") {
        return Ok(SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)));
    }
    bare.parse::<std::net::IpAddr>()
        .map(|ip| SocketAddr::new(ip, port))
        .map_err(|e| format!("Invalid address: {e}"))
}

/// Token of an `Authorization: Bearer <token>` header; the scheme is case-insensitive (RFC 7235).
fn bearer_token(header: &str) -> Option<&str> {
    let (scheme, token) = header.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim_start())
}

/// Constant-time comparison of a presented key against the configured one.
fn keys_equal(presented: &str, expected: &str) -> bool {
    let (a, b) = (presented.as_bytes(), expected.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether the host of a request's `Origin` is one the server trusts.
fn origin_is_trusted(origin: &str, trusted_hosts: &[Vec<String>]) -> bool {
    // The Host header may be a LAN IP; an Origin may not, unless the user listed it.
    is_trusted_origin(origin, trusted_hosts)
}

/// True when the process is a leftover Flint/Jan app or llama worker. Matched
/// on the exact executable name, so an unrelated program whose name merely
/// contains "jan" or "llama" is not called a leftover.
fn is_leftover_flint_process(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let stem = n.strip_suffix(".exe").unwrap_or(&n);
    matches!(
        stem,
        "flint" | "jan" | "flint-llama-worker" | "jan-llama-worker" | "llama-server"
    )
}

/// Look up which process holds `port`. It shells out (netstat/lsof), so it
/// only runs after a bind failure and is capped by a short timeout.
async fn lookup_port_owner(port: u16) -> Option<jan_utils::network::ProcessUsingPort> {
    let task =
        tokio::task::spawn_blocking(move || jan_utils::network::find_process_using_port(port));
    match tokio::time::timeout(std::time::Duration::from_secs(2), task).await {
        Ok(Ok(owner)) => owner,
        _ => None,
    }
}

/// A start failure with a stable code the settings page can switch on, so it
/// does not have to recognise English message text (RTE-005). `Display` is
/// the message alone, so callers that only print it see no change.
#[derive(Debug)]
pub struct StartError {
    pub code: &'static str,
    pub message: String,
}

pub const START_ERR_ALREADY_RUNNING: &str = "ALREADY_RUNNING";
pub const START_ERR_PORT_IN_USE: &str = "PORT_IN_USE";
pub const START_ERR_PORT_FORBIDDEN: &str = "PORT_FORBIDDEN";

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StartError {}

fn start_error(code: &'static str, message: String) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(StartError { code, message })
}

/// Convert a TCP bind failure into a user-facing message. Address-in-use
/// (Windows error 10048 / WSAEADDRINUSE, Unix EADDRINUSE) almost always means
/// a leftover Flint process or another service still owns the port after a
/// restart, so name the port and the remedy instead of surfacing a bare OS
/// errno. When `owner` is known (looked up after the failure), the message
/// names it and says whether it looks like a leftover Flint process. Any
/// other error is passed through unchanged.
fn map_bind_error(
    addr: SocketAddr,
    err: std::io::Error,
    owner: Option<&jan_utils::network::ProcessUsingPort>,
) -> Box<dyn std::error::Error + Send + Sync> {
    if err.kind() == std::io::ErrorKind::AddrInUse {
        let port = addr.port();
        let msg = match owner {
            Some(p) if is_leftover_flint_process(&p.name) => format!(
                "Port {port} ({addr}) is already in use, held by {name} (PID {pid}). This looks \
                 like a leftover Flint process; close it (or end it in Task Manager) and try \
                 again, or pick a different port in Settings > Local API Server.",
                name = p.name,
                pid = p.pid
            ),
            Some(p) => format!(
                "Port {port} ({addr}) is already in use, held by {name} (PID {pid}). Close that \
                 application and try again, or pick a different port in Settings > Local API \
                 Server.",
                name = p.name,
                pid = p.pid
            ),
            None => format!(
                "Port {port} ({addr}) is already in use. A previous Flint process may still be \
                 running or another application may be using the port. Close the leftover \
                 process and try again, or pick a different port in Settings > Local API Server."
            ),
        };
        return start_error(START_ERR_PORT_IN_USE, msg);
    }
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        // Windows error 10013: the port sits in a range Windows reserves
        // (Hyper-V, WSL, Docker), not one another program holds.
        return start_error(START_ERR_PORT_FORBIDDEN, format!(
            "Port {port} ({addr}) cannot be used: the operating system refused access to it. \
             On Windows this usually means the port is in a reserved range (Hyper-V, WSL or \
             Docker); pick a different port in Settings > Local API Server. ({err})",
            port = addr.port()
        ));
    }
    Box::new(err)
}

/// Bind `addr`. When a specific port is taken by another process (AddrInUse)
/// or the OS refuses it (PermissionDenied, Windows 10013 for reserved ranges),
/// bind an OS-assigned free port on the same host instead of failing. The
/// boolean says whether that fallback happened; the caller reads the real
/// port from the listener and reports it. When even the fallback cannot bind,
/// the original error is returned.
async fn bind_with_fallback(
    addr: SocketAddr,
) -> std::io::Result<(tokio::net::TcpListener, bool)> {
    match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => Ok((l, false)),
        Err(e)
            if addr.port() != 0
                && matches!(
                    e.kind(),
                    std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
                ) =>
        {
            let fallback = SocketAddr::new(addr.ip(), 0);
            match tokio::net::TcpListener::bind(fallback).await {
                Ok(l) => Ok((l, true)),
                Err(_) => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

/// A JSON response for the image and video routes: the body on success, an
/// OpenAI-shaped error with its own status otherwise.
fn json_response(
    outcome: Result<serde_json::Value, super::images_route::ApiError>,
    host_header: &str,
    origin_header: &str,
    config: &ProxyConfig,
) -> Response<ResBody> {
    let (status, payload) = match outcome {
        Ok(body) => (StatusCode::OK, body),
        Err(e) => (
            StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            e.body(),
        ),
    };
    let mut builder = Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json");
    builder = add_cors_headers_with_host_and_origin(
        builder,
        host_header,
        origin_header,
        &config.trusted_hosts,
    );
    builder.body(full(payload.to_string())).unwrap()
}

pub(crate) fn add_cors_headers_with_host_and_origin(
    builder: hyper::http::response::Builder,
    _host: &str,
    origin: &str,
    trusted_hosts: &[Vec<String>],
) -> hyper::http::response::Builder {
    let mut builder = builder;

    let origin_trusted = if !origin.is_empty() {
        origin_is_trusted(origin, trusted_hosts)
    } else {
        false
    };

    builder = builder
        .header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type, Host, Accept, Accept-Language, Cache-Control, Connection, DNT, If-Modified-Since, Keep-Alive, Origin, User-Agent, X-Requested-With, X-CSRF-Token, X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host, authorization, content-type, x-api-key")
        .header("Vary", "Origin");

    if origin_trusted {
        builder = builder
            .header("Access-Control-Allow-Origin", origin)
            .header("Access-Control-Allow-Credentials", "true");
    } else if origin.is_empty() {
        // curl and the OpenAI SDKs send no Origin; that is not a CORS problem.
        log::debug!("CORS: request has no Origin header, nothing to reflect");
    } else {
        log::warn!(
            "CORS: Origin '{}' is not trusted, not reflecting origin",
            origin
        );
    }

    builder
}

pub async fn is_server_running(server_handle: Arc<Mutex<Option<ServerHandle>>>) -> bool {
    let handle_guard = server_handle.lock().await;
    handle_guard.is_some()
}

#[allow(clippy::too_many_arguments)]
pub async fn start_server(
    server_handle: Arc<Mutex<Option<ServerHandle>>>,
    llama_state: Arc<LlamacppState>,
    mlx_sessions: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    host: String,
    port: u16,
    prefix: String,
    proxy_api_key: String,
    trusted_hosts: Vec<Vec<String>>,
    proxy_timeout: u64,
    provider_configs: Arc<Mutex<HashMap<String, ProviderConfig>>>,
    model_param_defaults: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    mcp_servers: SharedMcpServers,
    mcp_settings: Arc<Mutex<McpSettings>>,
    jan_data_folder: String,
    enable_server_tool_execution: bool,
    cors_enabled: bool,
) -> Result<u16, Box<dyn std::error::Error + Send + Sync>> {
    start_server_internal(
        server_handle,
        llama_state,
        mlx_sessions,
        host,
        port,
        prefix,
        proxy_api_key,
        trusted_hosts,
        proxy_timeout,
        provider_configs,
        model_param_defaults,
        mcp_servers,
        mcp_settings,
        jan_data_folder,
        enable_server_tool_execution,
        cors_enabled,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn start_server_internal(
    server_handle: Arc<Mutex<Option<ServerHandle>>>,
    llama_state: Arc<LlamacppState>,
    mlx_sessions: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    host: String,
    port: u16,
    prefix: String,
    proxy_api_key: String,
    trusted_hosts: Vec<Vec<String>>,
    proxy_timeout: u64,
    provider_configs: Arc<Mutex<HashMap<String, ProviderConfig>>>,
    model_param_defaults: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    mcp_servers: SharedMcpServers,
    mcp_settings: Arc<Mutex<McpSettings>>,
    jan_data_folder: String,
    enable_server_tool_execution: bool,
    cors_enabled: bool,
) -> Result<u16, Box<dyn std::error::Error + Send + Sync>> {
    let mut handle_guard = server_handle.lock().await;
    if handle_guard.is_some() {
        return Err(start_error(START_ERR_ALREADY_RUNNING, "Server is already running".into()));
    }

    let addr: SocketAddr = bind_addr(&host, port)?;

    // Binding to 0.0.0.0 exposes the server on the LAN, but that must NOT discard
    // the user's Trusted Hosts allowlist. LAN clients connect via http://192.168.x.x:port
    // and send that literal IP as the Host header; is_valid_host now accepts loopback
    // and private-range IP literals, which is safe against DNS rebinding (that sends an
    // attacker *hostname*, not an IP). Hostnames still require an explicit allowlist entry.

    // Calculate this before proxy_api_key is moved into ProxyConfig.
    let insecure_public_bind = is_insecure_public_bind(&host, &proxy_api_key);
    if insecure_public_bind {
        // Unauthenticated inference, model listing and (when enabled) MCP tool
        // execution for anything that can reach this machine: never start.
        return Err(format!(
            "Refusing to bind the API server to {host} without an API key. Set an API key in \
             Settings > Local API Server, or bind to 127.0.0.1."
        )
        .into());
    }

    let client = upstream_client(Some(proxy_timeout))?;
    let local_client = local_upstream_client(Some(proxy_timeout))?;

    // Bind first: the port that ends up bound (it differs from the requested
    // one after a fallback) is what the config and the caller must see.
    let (listener, fell_back) = match bind_with_fallback(addr).await {
        Ok(bound) => bound,
        Err(e) => {
            log::error!("Failed to bind to {addr}: {e}");
            let owner = if e.kind() == std::io::ErrorKind::AddrInUse {
                lookup_port_owner(addr.port()).await
            } else {
                None
            };
            return Err(map_bind_error(addr, e, owner.as_ref()));
        }
    };
    let bound_addr = listener.local_addr().unwrap_or(addr);
    if fell_back {
        log::warn!(
            "Port {} on {} is unavailable; the Flint API server is using free port {} instead",
            addr.port(),
            addr.ip(),
            bound_addr.port()
        );
    }
    log::info!("Flint API server started on http://{bound_addr}");

    let config = ProxyConfig {
        prefix,
        proxy_api_key,
        trusted_hosts,
        host: host.clone(),
        port: bound_addr.port(),
        enable_server_tool_execution,
        cors_enabled,
    };

    let server_task = tokio::spawn(async move {
        let handler = move |req| {
            let cors_enabled = config.cors_enabled;
            let response = proxy_request(
                req,
                client.clone(),
                local_client.clone(),
                config.clone(),
                llama_state.clone(),
                mlx_sessions.clone(),
                provider_configs.clone(),
                model_param_defaults.clone(),
                mcp_servers.clone(),
                mcp_settings.clone(),
                jan_data_folder.clone(),
            );
            // One choke point for the CORS switch rather than a check at
            // each of the many places a response is built.
            async move {
                let mut response = response.await?;
                if !cors_enabled {
                    strip_cors_headers(&mut response);
                }
                Ok::<_, hyper::Error>(response)
            }
        };
        accept_loop(listener, handler, MAX_CONNECTIONS, HEADER_READ_TIMEOUT).await;
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    });

    *handle_guard = Some(server_task);
    let actual_port = bound_addr.port();
    log::info!("Flint API server started successfully on port {actual_port}");
    Ok(actual_port)
}

/// Accept connections until the task is aborted. Connections live in a
/// `JoinSet` owned by this future, so aborting the accept task (stop_server)
/// drops the set and aborts every open connection, keep-alive ones included.
/// At most `max_conns` are served at once; `header_timeout` bounds how long a
/// connection may take to send a request head (slowloris, idle keep-alive).
async fn accept_loop<F, Fut>(
    listener: tokio::net::TcpListener,
    handler: F,
    max_conns: usize,
    header_timeout: std::time::Duration,
) where
    F: Fn(Request<Incoming>) -> Fut + Clone + Send + 'static,
    Fut: std::future::Future<Output = Result<Response<ResBody>, hyper::Error>> + Send + 'static,
{
    let permits = Arc::new(tokio::sync::Semaphore::new(max_conns));
    let mut conns = tokio::task::JoinSet::new();
    loop {
        // Wait for a free slot before accepting: past the cap, new peers queue
        // in the kernel backlog instead of each holding a task and a socket.
        let Ok(permit) = permits.clone().acquire_owned().await else {
            return;
        };
        let (stream, _) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => {
                log::error!("Accept error: {e}");
                // Out of file handles fails every accept at once; without a
                // pause the loop spins a core and floods the log.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };
        while conns.try_join_next().is_some() {}
        let io = TokioIo::new(stream);
        let svc = service_fn(handler.clone());
        conns.spawn(async move {
            let _permit = permit;
            let mut builder = http1::Builder::new();
            builder
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(header_timeout);
            if let Err(e) = builder.serve_connection(io, svc).await {
                log::debug!("Error serving connection: {e}");
            }
        });
    }
}

pub async fn stop_server(
    server_handle: Arc<Mutex<Option<ServerHandle>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut handle_guard = server_handle.lock().await;

    if let Some(handle) = handle_guard.take() {
        handle.abort();
        *handle_guard = None;
        log::info!("Flint API server stopped");
    } else {
        log::debug!("Server was not running");
    }

    Ok(())
}

/// Helper to format an Anthropic SSE event with proper event type and delimiters
pub(crate) fn sse_event(data: &serde_json::Value) -> Bytes {
    let event_type = data
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("message");
    Bytes::from(format!("event: {event_type}\ndata: {data}\n\n"))
}

/// Transform and forward streaming OpenAI response as Anthropic /messages chunks.
/// Handles both text content and tool_calls streaming.
/// Stream a native upstream response through an [`UpstreamConverter`], emitting
/// chat/completions SSE chunks. Uses [`SseAccumulator`] so events split across
/// network chunks are reassembled before translation.
/// A usage tap the forwarding task and its stream share.
type SharedTap = std::sync::Arc<std::sync::Mutex<super::usage_meter::UsageTap>>;

fn lock_tap(tap: &SharedTap) -> std::sync::MutexGuard<'_, super::usage_meter::UsageTap> {
    tap.lock().unwrap_or_else(|p| p.into_inner())
}

/// The model a metered request names, or `None` when it is not metered.
fn meter_model_of(metered: bool, body: &[u8]) -> Option<String> {
    metered
        .then(|| {
            serde_json::from_slice::<serde_json::Value>(body)
                .ok()
                .and_then(|v| v.get("model").and_then(|m| m.as_str().map(String::from)))
        })
        .flatten()
}

/// `stream` with every chunk also pushed into `tap` when `on`. Usage is read
/// from the upstream's own bytes, before any conversion.
fn tapped<S>(
    stream: S,
    tap: &SharedTap,
    on: bool,
) -> impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin
where
    S: futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    let tap = tap.clone();
    futures_util::StreamExt::inspect(stream, move |chunk| {
        if let (true, Ok(c)) = (on, chunk) {
            lock_tap(&tap).push(c);
        }
    })
}

/// Record what a finished answer used, when it was metered and said.
fn finish_meter(model: Option<String>, folder: &str, tap: &SharedTap) {
    let counts = lock_tap(tap).counts();
    if let (Some(model), Some((input, output))) = (model, counts) {
        super::usage_meter::record(std::path::Path::new(folder), &model, input, output);
        super::usage_meter::forget();
    }
}

async fn forward_converted_stream<S>(
    mut stream: S,
    mut sender: BodySender,
    converter: Box<dyn UpstreamConverter>,
) where
    S: futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    let mut acc = SseAccumulator::new();
    let mut state = StreamState::default();
    'outer: while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                for event in acc.push_bytes(&chunk) {
                    for payload in converter.convert_stream_event(&event, &mut state) {
                        let framed = Bytes::from(format!("data: {payload}\n\n"));
                        if sender.send_data(framed).await.is_err() {
                            break 'outer;
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("Converter stream error: {e}");
                break;
            }
        }
    }
    if let Some(event) = acc.finish() {
        for payload in converter.convert_stream_event(&event, &mut state) {
            let framed = Bytes::from(format!("data: {payload}\n\n"));
            if sender.send_data(framed).await.is_err() {
                return;
            }
        }
    }
}

/// Translate a non-streaming native upstream response into a chat.completion
/// object and forward it as a single body frame.
async fn forward_converted_non_streaming(
    body: Result<Bytes, reqwest::Error>,
    mut sender: BodySender,
    converter: Box<dyn UpstreamConverter>,
) {
    match body {
        Ok(bytes) => {
            let out = match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(v) => serde_json::to_vec(&converter.convert_response(&v))
                    .unwrap_or_else(|_| bytes.to_vec()),
                Err(_) => bytes.to_vec(),
            };
            let _ = sender.send_data(Bytes::from(out)).await;
        }
        Err(e) => log::error!("Converter non-streaming error: {e}"),
    }
}

async fn transform_and_forward_stream<S>(
    mut stream: S,
    mut sender: BodySender,
    _destination_path: &str,
) where
    S: futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    let mut encoder = AnthropicStreamEncoder::default();
    // Bytes decode across chunk boundaries, and a line split between two
    // chunks waits for its end, so neither a multi-byte character nor a
    // `data:` line is cut in half (#195).
    let mut utf8 = Utf8ChunkDecoder::default();
    let mut pending_lines = String::new();
    let mut transport_error = false;

    'outer: loop {
        // When the stream ends (or errors), whatever is still buffered is the
        // final line, even without a trailing newline -- e.g. a bare
        // `data: [DONE]` -- so it is processed before stopping.
        let (chunk_str, stream_ended) = match stream.next().await {
            Some(Ok(chunk)) => {
                pending_lines.push_str(&utf8.push(&chunk));
                let Some(end) = pending_lines.rfind('\n') else {
                    continue;
                };
                (pending_lines.drain(..=end).collect::<String>(), false)
            }
            end => {
                if let Some(Err(e)) = end {
                    log::error!("Stream error: {e}");
                    transport_error = true;
                }
                pending_lines.push_str(&utf8.finish());
                if pending_lines.is_empty() {
                    break;
                }
                pending_lines.push('\n');
                (std::mem::take(&mut pending_lines), true)
            }
        };
        for line in chunk_str.lines() {
            let Some(events) = encoder.push_line(line) else {
                break 'outer;
            };
            for event in events {
                if sender.send_data(sse_event(&event)).await.is_err() {
                    return;
                }
            }
        }
        if stream_ended {
            break;
        }
    }

    for event in encoder.finish(transport_error) {
        if sender.send_data(sse_event(&event)).await.is_err() {
            return;
        }
    }
    log::debug!("Streaming complete (Anthropic format)");
}

/// OpenAI chat-completion stream chunks in, Anthropic Messages events out.
/// Holds which content blocks are open and what the closing events need.
struct AnthropicStreamEncoder {
    /// No `message_start` sent yet.
    is_first: bool,
    accumulated_content: String,
    text_block_index: Option<usize>,
    /// OpenAI tool index -> Anthropic block index.
    tool_blocks: HashMap<usize, usize>,
    next_block_index: usize,
    /// The finish chunk only closes the blocks; the closing events wait for
    /// `[DONE]` / EOF so a trailing usage chunk can still be read.
    stop_reason: Option<&'static str>,
    usage: Option<serde_json::Value>,
}

impl Default for AnthropicStreamEncoder {
    fn default() -> Self {
        Self {
            is_first: true,
            accumulated_content: String::new(),
            text_block_index: None,
            tool_blocks: HashMap::new(),
            next_block_index: 0,
            stop_reason: None,
            usage: None,
        }
    }
}

fn block_stop(index: usize) -> serde_json::Value {
    serde_json::json!({"type": "content_block_stop", "index": index})
}

impl AnthropicStreamEncoder {
    /// Events for one line of the upstream stream; `None` at `data: [DONE]`.
    fn push_line(&mut self, line: &str) -> Option<Vec<serde_json::Value>> {
        let Some(data) = line.strip_prefix("data:") else {
            return Some(Vec::new());
        };
        let data = data.trim_start_matches("data:").trim();
        if data == "[DONE]" {
            return None;
        }
        Some(match serde_json::from_str::<serde_json::Value>(data) {
            Ok(chunk) => self.push_chunk(&chunk),
            Err(_) => Vec::new(),
        })
    }

    /// Events for one parsed chat-completion chunk.
    fn push_chunk(&mut self, json_chunk: &serde_json::Value) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        // The backend's real usage, on a trailing chunk (empty `choices`)
        // or on the finish chunk itself.
        if let Some(u) = json_chunk.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(u.clone());
        }
        let choice = json_chunk
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first());
        let Some(delta) = choice.and_then(|c| c.get("delta")) else {
            return out;
        };
        let finish_reason = choice
            .and_then(|c| c.get("finish_reason"))
            .filter(|fr| !fr.is_null());
        if self.is_first {
            out.push(Self::message_start(json_chunk, delta));
            self.is_first = false;
        }
        if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
            self.on_text(text, &mut out);
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(|tc| tc.as_array()) {
            self.on_tool_calls(tool_calls, &mut out);
        }
        if let Some(fr) = finish_reason {
            self.on_finish(fr, &mut out);
        }
        out
    }

    fn message_start(json_chunk: &serde_json::Value, delta: &serde_json::Value) -> serde_json::Value {
        let role = delta
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("assistant");
        let message_id = json_chunk.get("id").cloned().unwrap_or(serde_json::json!(""));
        let model = json_chunk.get("model").cloned().unwrap_or(serde_json::json!(""));
        serde_json::json!({
            "type": "message_start",
            "message": {
                "id": message_id,
                "type": "message",
                "role": role,
                "content": [],
                "model": model,
                "stop_reason": serde_json::Value::Null,
                "stop_sequence": serde_json::Value::Null,
                "usage": { "input_tokens": 0, "output_tokens": 0 }
            }
        })
    }

    fn on_text(&mut self, text: &str, out: &mut Vec<serde_json::Value>) {
        if text.is_empty() {
            return;
        }
        let idx = match self.text_block_index {
            Some(idx) => idx,
            None => {
                let idx = self.next_block_index;
                self.next_block_index += 1;
                self.text_block_index = Some(idx);
                out.push(serde_json::json!({
                    "type": "content_block_start",
                    "index": idx,
                    "content_block": { "type": "text", "text": "" }
                }));
                idx
            }
        };
        self.accumulated_content.push_str(text);
        out.push(serde_json::json!({
            "type": "content_block_delta",
            "index": idx,
            "delta": { "type": "text_delta", "text": text }
        }));
    }

    fn on_tool_calls(&mut self, tool_calls: &[serde_json::Value], out: &mut Vec<serde_json::Value>) {
        // Close the text block before tool blocks.
        if let Some(idx) = self.text_block_index.take() {
            out.push(block_stop(idx));
        }
        for tc in tool_calls {
            let tc_index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
            // A new tool call carries its id (and function name).
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                let name = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                let idx = self.next_block_index;
                self.next_block_index += 1;
                self.tool_blocks.insert(tc_index, idx);
                out.push(serde_json::json!({
                    "type": "content_block_start",
                    "index": idx,
                    "content_block": {
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": {}
                    }
                }));
            }
            let args = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|a| a.as_str())
                .filter(|a| !a.is_empty());
            if let (Some(args), Some(&idx)) = (args, self.tool_blocks.get(&tc_index)) {
                out.push(serde_json::json!({
                    "type": "content_block_delta",
                    "index": idx,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": args
                    }
                }));
            }
        }
    }

    fn on_finish(&mut self, finish_reason: &serde_json::Value, out: &mut Vec<serde_json::Value>) {
        if let Some(idx) = self.text_block_index.take() {
            out.push(block_stop(idx));
        }
        let mut tool_indices: Vec<usize> = self.tool_blocks.values().copied().collect();
        tool_indices.sort();
        out.extend(tool_indices.into_iter().map(block_stop));
        self.stop_reason = Some(anthropic_stop_reason(finish_reason.as_str().unwrap_or("stop")));
        self.tool_blocks.clear();
        // `message_delta` / `message_stop` follow at `[DONE]` / EOF, after any
        // trailing usage chunk.
    }

    /// The closing events once the upstream stream is over.
    fn finish(&mut self, transport_error: bool) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        // No `message_start` yet: the stream carried nothing usable.
        if self.is_first {
            if transport_error {
                out.push(serde_json::json!({
                    "type": "error",
                    "error": {"type": "api_error", "message": "upstream stream failed"}
                }));
                return out;
            }
            out.push(serde_json::json!({
                "type": "message_start",
                "message": {
                    "id": "", "type": "message", "role": "assistant", "content": [],
                    "model": "", "stop_reason": serde_json::Value::Null,
                    "stop_sequence": serde_json::Value::Null,
                    "usage": { "input_tokens": 0, "output_tokens": 0 }
                }
            }));
        }
        // Close blocks still open (the stream ended before a finish chunk).
        let mut open: Vec<usize> = self.tool_blocks.values().copied().collect();
        open.extend(self.text_block_index.take());
        open.sort();
        out.extend(open.into_iter().map(block_stop));
        // A connection that broke before the model finished is an error, not
        // a normal end of turn.
        if transport_error && self.stop_reason.is_none() {
            out.push(serde_json::json!({
                "type": "error",
                "error": {"type": "api_error", "message": "upstream stream interrupted"}
            }));
            return out;
        }
        let stop_reason = self.stop_reason.unwrap_or(if self.tool_blocks.is_empty() {
            "end_turn"
        } else {
            "tool_use"
        });
        let usage_json = match &self.usage {
            Some(u) => anthropic_usage(u),
            None => {
                // The backend sent no usage: estimate from the text, as before.
                log::debug!("backend sent no usage; estimating output tokens");
                serde_json::json!({
                    "input_tokens": 0,
                    "output_tokens": self.accumulated_content.split_whitespace().count() as u64
                })
            }
        };
        out.push(serde_json::json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": stop_reason,
                "stop_sequence": serde_json::Value::Null
            },
            "usage": usage_json
        }));
        out.push(serde_json::json!({"type": "message_stop"}));
        out
    }
}

/// Forward non-streaming OpenAI response as Anthropic /messages response
async fn forward_non_streaming(
    response_body: Result<Bytes, reqwest::Error>,
    mut sender: BodySender,
    destination_path: &str,
) {
    let bytes = match response_body {
        Ok(bytes) => bytes,
        Err(e) => {
            log::error!("Failed to get response body: {e}");
            return;
        }
    };

    if let Ok(json_response) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        if destination_path == "/messages" {
            // Transform to Anthropic format
            let anthropic_response = transform_openai_response_to_anthropic(&json_response);
            if sender
                .send_data(Bytes::from(anthropic_response.to_string()))
                .await
                .is_err()
            {
                log::debug!("Client disconnected");
            }
        } else {
            // Pass through as-is
            if sender.send_data(bytes).await.is_err() {
                log::debug!("Client disconnected");
            }
        }
    } else {
        // Pass through raw response
        if sender.send_data(bytes).await.is_err() {
            log::debug!("Client disconnected");
        }
    }
}

/// The client every provider request is dispatched with (and the fresh one a
/// fallback uses). It follows a redirect only on the same origin
/// (Jozkah/jan#214): reqwest's default drops `Authorization` on a host change
/// but keeps `x-api-key`, `x-goog-api-key` and every forwarded header, so a
/// provider answering with a redirect could send the user's key anywhere.
fn upstream_client(timeout_secs: Option<u64>) -> reqwest::Result<Client> {
    build_upstream_client(timeout_secs, false)
}

/// Same as `upstream_client` but never routed through HTTP_PROXY / the system
/// proxy. The loopback engine worker must be dialled directly: a corporate
/// proxy cannot reach 127.0.0.1 and answers 403 instead (#260).
fn local_upstream_client(timeout_secs: Option<u64>) -> reqwest::Result<Client> {
    build_upstream_client(timeout_secs, true)
}

fn build_upstream_client(timeout_secs: Option<u64>, bypass_proxy: bool) -> reqwest::Result<Client> {
    let mut builder = Client::builder()
        .redirect(crate::core::net::transport::same_origin_redirects());
    if bypass_proxy {
        builder = builder.no_proxy();
    }
    if let Some(secs) = timeout_secs {
        // The limit is on silence, not on the whole request: a long prefill and
        // a long generation from a big local model are one request that keeps
        // sending, and a total timeout cut it off mid-stream.
        builder = builder
            .connect_timeout(std::time::Duration::from_secs(30))
            .read_timeout(std::time::Duration::from_secs(secs))
            .pool_max_idle_per_host(10)
            .pool_idle_timeout(std::time::Duration::from_secs(30));
    }
    crate::core::net::tls::apply12(builder).build()
}

#[cfg(test)]
mod redirect_tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A provider that redirects to another server must not get the user's
    /// key sent there: the second server never sees a connection.
    #[tokio::test]
    async fn a_cross_origin_redirect_is_not_followed_with_the_key() {
        let thief = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let thief_port = thief.local_addr().unwrap().port();
        let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_port = provider.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = provider.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let reply = format!(
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{thief_port}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = sock.write_all(reply.as_bytes()).await;
            }
        });
        for client in [super::upstream_client(Some(30)).unwrap(), super::upstream_client(None).unwrap()] {
            // Bounded: a followed redirect would wait on the silent second
            // server, and the check below is what reports that.
            let sent = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                client
                    .post(format!("http://127.0.0.1:{provider_port}/v1/messages"))
                    .header("x-api-key", "sk-ant-THEKEY")
                    .header("x-goog-api-key", "AIzaTHEKEY")
                    .body("{}")
                    .send(),
            )
            .await;
            assert!(!matches!(sent, Ok(Ok(_))), "the cross-origin redirect was followed");
        }
        let reached =
            tokio::time::timeout(std::time::Duration::from_millis(300), thief.accept()).await;
        assert!(reached.is_err(), "the redirect target received the request");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn bearer_scheme_is_case_insensitive() {
        assert_eq!(super::bearer_token("Bearer k"), Some("k"));
        assert_eq!(super::bearer_token("bearer k"), Some("k"));
        assert_eq!(super::bearer_token("BEARER k"), Some("k"));
        assert_eq!(super::bearer_token("Basic k"), None);
        assert_eq!(super::bearer_token("Bearerk"), None);
    }

    #[test]
    fn engine_responses_name_the_model_id_not_its_file_path() {
        use super::ModelFieldRewriter;
        let mut r = ModelFieldRewriter::new("gemma-3-4b-it-Q4_K_M".into());
        // An SSE event split across chunks, then [DONE].
        let a = r.push(br#"data: {"id":"x","model":"C:\\tmp\\flint-models\\gemma-3"#);
        assert!(a.is_empty());
        let b = r.push(b"-4b-it-Q4_K_M.gguf\",\"choices\":[]}\n\ndata: [DONE]\n\n");
        let text = String::from_utf8(b.to_vec()).unwrap();
        assert!(text.starts_with("data: {"), "{text}");
        assert!(text.contains(r#""model":"gemma-3-4b-it-Q4_K_M""#), "{text}");
        assert!(!text.contains("flint-models"), "{text}");
        assert!(text.ends_with("data: [DONE]\n\n"), "{text}");
        assert!(r.finish().is_empty());

        // A non-streaming body with no trailing newline.
        let mut r = ModelFieldRewriter::new("qwen".into());
        assert!(r.push(br#"{"model":"/m/qwen.gguf","usage":{}}"#).is_empty());
        let body = String::from_utf8(r.finish().to_vec()).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["model"],
            "qwen"
        );

        // An id that is already a name is left byte for byte.
        let mut r = ModelFieldRewriter::new("qwen".into());
        let line = b"data: {\"model\": \"qwen\", \"x\": 1}\n";
        assert_eq!(&r.push(line)[..], &line[..]);
    }

    #[test]
    fn preset_context_length_falls_back_to_the_configured_window() {
        use super::preset_context_length as ctx;
        let ini = "[*]\nctx-size = 16384\n\n[qwen]\nctx-size = 65536\n\n[plain]\nmodel = x.gguf\n\n[auto]\nctx-size = 0\n";
        assert_eq!(ctx(ini, "qwen"), Some(65536));
        assert_eq!(ctx(ini, "plain"), Some(16384));
        assert_eq!(ctx(ini, "auto"), None);
        assert_eq!(ctx("[m]\nmodel = x.gguf\n", "m"), None);
        assert_eq!(ctx("", "m"), None);
    }

    #[test]
    fn engine_context_length_reads_only_what_the_engine_reports() {
        use super::engine_context_length as ctx;
        let loaded = serde_json::json!({"id":"m","status":{"value":"loaded","args":["llama-server","--ctx-size","8192"]}});
        assert_eq!(ctx(&loaded), Some(8192));
        let short = serde_json::json!({"status":{"args":["-c","4096"]}});
        assert_eq!(ctx(&short), Some(4096));
        assert_eq!(ctx(&serde_json::json!({"id":"m","status":{"value":"unloaded"}})), None);
        assert_eq!(ctx(&serde_json::json!({"id":"m"})), None);
    }

    use super::{
        anthropic_context_error, bind_addr, bind_with_fallback, error_json, is_insecure_public_bind, keys_equal, is_local_url, map_bind_error,
        model_ids_match,
    };
    use std::net::SocketAddr;

    /// #195: a final `data: [DONE]` with no trailing newline is still
    /// processed when the upstream stream ends, so the client gets its
    /// closing `message_stop` event.
    #[tokio::test]
    async fn a_final_done_line_without_newline_is_not_dropped() {
        use http_body_util::BodyExt;
        use hyper::body::Bytes;

        let chunks: Vec<Result<Bytes, reqwest::Error>> = vec![
            Ok(Bytes::from_static(
                b"data: {\"id\":\"m1\",\"model\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
            )),
            Ok(Bytes::from_static(b"data: [DONE]")),
        ];
        let (sender, body) = super::body_channel();
        super::transform_and_forward_stream(futures_util::stream::iter(chunks), sender, "/v1/messages")
            .await;
        let out = body.collect().await.unwrap().to_bytes();
        let out = String::from_utf8_lossy(&out);
        assert!(out.contains("\"text_delta\""), "{out}");
        assert!(out.contains("\"message_stop\""), "{out}");
    }

    async fn anthropic_stream_out(chunks: Vec<&'static str>) -> String {
        use http_body_util::BodyExt;
        use hyper::body::Bytes;
        let chunks: Vec<Result<Bytes, reqwest::Error>> = chunks
            .into_iter()
            .map(|c| Ok(Bytes::from_static(c.as_bytes())))
            .collect();
        let (sender, body) = super::body_channel();
        super::transform_and_forward_stream(futures_util::stream::iter(chunks), sender, "/v1/messages")
            .await;
        let out = body.collect().await.unwrap().to_bytes();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn anthropic_tool_choice_maps_auto_any_none_and_named() {
        let req = |tc: serde_json::Value| {
            super::transform_anthropic_to_openai(&serde_json::json!({
                "model": "m", "messages": [{"role": "user", "content": "hi"}],
                "tool_choice": tc
            }))
            .unwrap()
        };
        assert_eq!(req(serde_json::json!({"type": "auto"}))["tool_choice"], "auto");
        assert_eq!(req(serde_json::json!({"type": "any"}))["tool_choice"], "required");
        assert_eq!(req(serde_json::json!({"type": "none"}))["tool_choice"], "none");
        let named = req(serde_json::json!({"type": "tool", "name": "get_weather"}));
        assert_eq!(named["tool_choice"]["function"]["name"], "get_weather");
        assert_eq!(named["tool_choice"]["type"], "function");
        let serial = req(serde_json::json!({"type": "auto", "disable_parallel_tool_use": true}));
        assert_eq!(serial["parallel_tool_calls"], false);
    }

    #[test]
    fn anthropic_streaming_request_asks_for_usage() {
        let body = |stream: bool| {
            super::transform_anthropic_to_openai(&serde_json::json!({
                "model": "m", "messages": [{"role": "user", "content": "hi"}], "stream": stream
            }))
            .unwrap()
        };
        assert_eq!(body(true)["stream_options"]["include_usage"], true);
        assert!(body(false).get("stream_options").is_none());
    }

    #[test]
    fn anthropic_response_usage_is_anthropic_shape() {
        let out = super::transform_openai_response_to_anthropic(&serde_json::json!({
            "id": "x", "model": "m",
            "choices": [{"message": {"content": "hi"}, "finish_reason": "content_filter"}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18,
                      "prompt_tokens_details": {"cached_tokens": 4}}
        }));
        assert_eq!(out["usage"]["input_tokens"], 11);
        assert_eq!(out["usage"]["output_tokens"], 7);
        assert_eq!(out["usage"]["cache_read_input_tokens"], 4);
        assert!(out["usage"].get("prompt_tokens").is_none());
        assert_eq!(out["stop_reason"], "refusal");

        let unknown = super::transform_openai_response_to_anthropic(&serde_json::json!({
            "choices": [{"message": {"content": "hi"}, "finish_reason": "weird"}]
        }));
        assert_eq!(unknown["stop_reason"], "end_turn");
        assert_eq!(unknown["usage"]["output_tokens"], 0);
    }

    #[tokio::test]
    async fn anthropic_stream_reports_trailing_usage_chunk() {
        let out = anthropic_stream_out(vec![
            "data: {\"id\":\"m1\",\"model\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"m1\",\"model\":\"x\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"id\":\"m1\",\"model\":\"x\",\"choices\":[],\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":9}}\n\n",
            "data: [DONE]\n\n",
        ])
        .await;
        assert!(out.contains("\"input_tokens\":42"), "{out}");
        assert!(out.contains("\"output_tokens\":9"), "{out}");
        assert!(out.contains("\"stop_reason\":\"end_turn\""), "{out}");
        let delta = out.find("message_delta").expect("message_delta");
        let stop = out.find("message_stop").expect("message_stop");
        assert!(delta < stop, "{out}");
        assert_eq!(out.matches("message_stop").count(), 2, "{out}"); // event name + type
    }

    #[tokio::test]
    async fn anthropic_stream_without_finish_ends_cleanly_with_stop() {
        let out = anthropic_stream_out(vec![
            "data: {\"id\":\"m1\",\"model\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
        ])
        .await;
        assert!(out.contains("content_block_stop"), "{out}");
        assert!(out.contains("\"stop_reason\":\"end_turn\""), "{out}");
        assert!(out.contains("\"type\":\"message_stop\""), "{out}");
    }

    /// #144: the "Verbose Server Logs" switch reaches the server, and the
    /// line it logs never carries a query string.
    #[test]
    fn verbose_logging_is_switchable_and_leaves_out_the_query() {
        super::set_verbose_logs(true);
        assert!(super::verbose_logs());
        super::set_verbose_logs(false);
        assert!(!super::verbose_logs());

        let uri: hyper::Uri = "/v1/chat/completions?api_key=SECRET".parse().unwrap();
        let line = super::verbose_request_line(&hyper::Method::POST, &uri);
        assert_eq!(line, "API server request: POST /v1/chat/completions");
    }

    #[test]
    fn loopback_never_warns() {
        for host in ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.2", "::ffff:127.0.0.1"] {
            assert!(!is_insecure_public_bind(host, ""), "{host} should be safe");
            assert!(!is_insecure_public_bind(host, "secret"));
        }
    }

    #[test]
    fn public_bind_without_key_warns() {
        assert!(is_insecure_public_bind("0.0.0.0", ""));
        assert!(bind_addr("::1", 80).is_ok());
        assert!(bind_addr("[::1]", 80).is_ok());
        assert!(keys_equal("abc", "abc"));
        assert!(!keys_equal("abc", "abd"));
        assert!(!keys_equal("abc", "abcd"));
        assert!(is_insecure_public_bind("192.168.1.10", ""));
    }

    #[test]
    fn public_bind_with_key_is_ok() {
        assert!(!is_insecure_public_bind("0.0.0.0", "secret"));
        assert!(!is_insecure_public_bind("192.168.1.10", "secret"));
    }

    /// A free port binds as asked; a taken port falls back to another free
    /// port on the same host instead of failing.
    #[tokio::test]
    async fn bind_falls_back_to_a_free_port_when_the_port_is_taken() {
        let holder = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let taken = holder.local_addr().unwrap();

        let (listener, fell_back) = bind_with_fallback(taken).await.unwrap();
        let bound = listener.local_addr().unwrap();
        assert!(fell_back);
        assert_ne!(bound.port(), taken.port());
        assert_eq!(bound.ip(), taken.ip());
        drop(listener);
        drop(holder);

        // Free now: no fallback, same port.
        let (listener, fell_back) = bind_with_fallback(taken).await.unwrap();
        assert!(!fell_back);
        assert_eq!(listener.local_addr().unwrap(), taken);
    }

    #[test]
    fn addr_in_use_maps_to_actionable_message() {
        let addr: SocketAddr = "127.0.0.1:1337".parse().unwrap();
        let err = std::io::Error::new(std::io::ErrorKind::AddrInUse, "Address already in use");
        let msg = map_bind_error(addr, err, None).to_string();
        assert!(msg.contains("1337"), "should name the port: {msg}");
        assert!(
            msg.contains("already in use") && msg.contains("process"),
            "should explain the leftover-process remedy: {msg}"
        );
    }

    fn fake_owner(name: &str) -> jan_utils::network::ProcessUsingPort {
        jan_utils::network::ProcessUsingPort {
            pid: 4242,
            name: name.to_string(),
            cmd: vec![],
        }
    }

    #[test]
    fn addr_in_use_names_a_foreign_owner() {
        let addr: SocketAddr = "127.0.0.1:1337".parse().unwrap();
        let err = std::io::Error::new(std::io::ErrorKind::AddrInUse, "in use");
        let owner = fake_owner("nginx.exe");
        let msg = map_bind_error(addr, err, Some(&owner)).to_string();
        assert!(msg.contains("1337") && msg.contains("nginx.exe (PID 4242)"), "{msg}");
        assert!(!msg.contains("leftover Flint"), "{msg}");
    }

    #[test]
    fn addr_in_use_flags_a_leftover_flint_owner() {
        let addr: SocketAddr = "127.0.0.1:1337".parse().unwrap();
        for name in ["Flint.exe", "jan", "llama-server.exe"] {
            let err = std::io::Error::new(std::io::ErrorKind::AddrInUse, "in use");
            let owner = fake_owner(name);
            let msg = map_bind_error(addr, err, Some(&owner)).to_string();
            assert!(
                msg.contains("(PID 4242)") && msg.contains("leftover Flint"),
                "{msg}"
            );
        }
    }

    #[test]
    fn addr_in_use_does_not_call_a_lookalike_name_a_leftover() {
        let addr: SocketAddr = "127.0.0.1:1337".parse().unwrap();
        for name in ["janitor.exe", "ollama", "llamafile.exe"] {
            let err = std::io::Error::new(std::io::ErrorKind::AddrInUse, "in use");
            let owner = fake_owner(name);
            let msg = map_bind_error(addr, err, Some(&owner)).to_string();
            assert!(!msg.contains("leftover Flint"), "{msg}");
        }
    }

    #[test]
    fn non_addr_in_use_error_passes_through() {
        let addr: SocketAddr = "127.0.0.1:1337".parse().unwrap();
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let msg = map_bind_error(addr, err, None).to_string();
        assert!(
            msg.contains("denied"),
            "should keep the original error: {msg}"
        );
    }

    #[test]
    fn bind_errors_carry_a_stable_code() {
        let addr: SocketAddr = "127.0.0.1:1337".parse().unwrap();
        let code = |kind| {
            let e = map_bind_error(addr, std::io::Error::new(kind, "x"), None);
            e.downcast_ref::<super::StartError>().map(|s| s.code)
        };
        assert_eq!(code(std::io::ErrorKind::AddrInUse), Some(super::START_ERR_PORT_IN_USE));
        assert_eq!(code(std::io::ErrorKind::PermissionDenied), Some(super::START_ERR_PORT_FORBIDDEN));
        assert_eq!(code(std::io::ErrorKind::Other), None);
    }

    #[test]
    fn permission_denied_names_the_reserved_port_range() {
        let addr: SocketAddr = "127.0.0.1:1337".parse().unwrap();
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let msg = map_bind_error(addr, err, None).to_string();
        assert!(msg.contains("1337") && msg.contains("reserved"), "{msg}");
    }

    #[test]
    fn model_ids_match_treats_dot_and_underscore_alike() {
        assert!(model_ids_match("Qwen3_5-9B", "Qwen3.5-9B"));
        assert!(model_ids_match("Qwen3.5-9B", "Qwen3.5-9B"));
        assert!(!model_ids_match("Qwen3-5-9B", "Qwen3.5-9B"));
        assert!(!model_ids_match("Qwen3.5-9B", "Qwen3.5-9b"));
        assert!(!model_ids_match("a", "ab"));
    }

    #[test]
    fn error_json_keeps_the_message_and_adds_a_code() {
        let v: serde_json::Value =
            serde_json::from_str(&error_json("it \"broke\"", "server_error", "backend_unavailable"))
                .unwrap();
        assert_eq!(v["error"]["message"], "it \"broke\"");
        assert_eq!(v["error"]["type"], "server_error");
        assert_eq!(v["error"]["code"], "backend_unavailable");
    }

    #[test]
    fn a_context_overflow_reaches_claude_code_as_an_anthropic_error() {
        let engine = r#"{"error":{"code":400,"message":"request (24100 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":24100,"n_ctx":8192}}"#;
        let out = anthropic_context_error(engine).expect("rewritten");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["type"], "error");
        assert_eq!(v["error"]["type"], "invalid_request_error");
        let message = v["error"]["message"].as_str().unwrap();
        // The wording Claude Code recognises as "compact and retry".
        assert!(message.starts_with("prompt is too long: 24100 tokens > 8192 maximum"));
        assert!(message.contains("Context Size"));
    }

    #[test]
    fn other_engine_errors_are_left_alone() {
        assert!(anthropic_context_error(r#"{"error":{"type":"server_error"}}"#).is_none());
        assert!(anthropic_context_error("not json").is_none());
    }

    #[test]
    fn local_urls_are_told_from_remote_ones() {
        assert!(is_local_url("http://127.0.0.1:8080/v1/chat/completions"));
        assert!(is_local_url("http://localhost:1/v1"));
        assert!(is_local_url("http://[::1]:5000/v1"));
        assert!(!is_local_url("https://api.openai.com/v1"));
        assert!(!is_local_url("not a url"));
    }
}

#[cfg(test)]
mod api_limits_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    async fn echo(req: Request<Incoming>) -> Result<Response<ResBody>, hyper::Error> {
        Ok(match read_limited(req.into_body(), 10).await {
            Ok(b) => Response::new(full(b)),
            Err(e) => body_error_response(e, "", "", &[]),
        })
    }

    async fn start(max: usize, header: Duration) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        (addr, tokio::spawn(accept_loop(listener, echo, max, header)))
    }

    async fn read_some(s: &mut TcpStream) -> String {
        let mut buf = vec![0u8; 4096];
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
            .await
            .expect("read timed out")
            .unwrap_or(0);
        String::from_utf8_lossy(&buf[..n]).to_string()
    }

    #[tokio::test]
    async fn api_rejects_oversize_content_length_with_413() {
        let (addr, task) = start(8, Duration::from_secs(5)).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        // Declares 100 bytes, sends none: refused before any read.
        s.write_all(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n").await.unwrap();
        assert!(read_some(&mut s).await.starts_with("HTTP/1.1 413"));
        task.abort();
    }

    #[tokio::test]
    async fn api_rejects_chunked_body_over_cap() {
        let (addr, task) = start(8, Duration::from_secs(5)).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(
            b"POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n20\r\n01234567890123456789012345678901\r\n0\r\n\r\n",
        )
        .await
        .unwrap();
        assert!(read_some(&mut s).await.starts_with("HTTP/1.1 413"));
        task.abort();
    }

    #[tokio::test]
    async fn api_slow_header_connection_is_closed() {
        let (addr, task) = start(8, Duration::from_millis(300)).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"POST / HTTP/1.1\r\nHost: x\r\n").await.unwrap(); // never finishes
        // The server drops the connection (optionally after a 408): EOF follows.
        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut buf))
            .await
            .expect("slow-header connection was not closed")
            .ok();
        task.abort();
    }

    #[tokio::test]
    async fn api_stop_closes_keepalive_connections() {
        let (addr, task) = start(8, Duration::from_secs(30)).await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi").await.unwrap();
        assert!(read_some(&mut s).await.starts_with("HTTP/1.1 200"));
        task.abort(); // what stop_server does
        let _ = task.await;
        let mut buf = [0u8; 16];
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
            .await
            .expect("keep-alive connection survived stop")
            .unwrap_or(0);
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn api_connection_cap_queues_extra_clients() {
        let (addr, task) = start(1, Duration::from_secs(30)).await;
        let mut first = TcpStream::connect(addr).await.unwrap();
        first.write_all(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi").await.unwrap();
        assert!(read_some(&mut first).await.starts_with("HTTP/1.1 200"));
        let mut second = TcpStream::connect(addr).await.unwrap();
        second.write_all(b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi").await.unwrap();
        let mut buf = [0u8; 16];
        // The only slot is held by `first`: no answer for `second` yet.
        assert!(tokio::time::timeout(Duration::from_millis(300), second.read(&mut buf)).await.is_err());
        drop(first);
        assert!(read_some(&mut second).await.starts_with("HTTP/1.1 200"));
        task.abort();
    }

    fn hn(s: &str) -> hyper::header::HeaderName {
        hyper::header::HeaderName::from_bytes(s.as_bytes()).unwrap()
    }

    #[test]
    fn forwards_to_upstream_drops_cookie_and_proxy_headers() {
        for h in [
            "cookie", "set-cookie", "proxy-authorization", "forwarded", "x-forwarded-for",
            "x-forwarded-host", "sec-fetch-site", "sec-ch-ua", "authorization", "x-api-key",
            "host", "origin", "referer", "content-length", "transfer-encoding",
        ] {
            assert!(!forwards_to_upstream(&hn(h)), "{h} must not be forwarded");
        }
    }

    #[test]
    fn forwards_to_upstream_keeps_anthropic_beta() {
        for h in [
            "anthropic-beta", "anthropic-version", "openai-organization", "openai-project",
            "x-stainless-lang", "content-type", "accept", "user-agent",
        ] {
            assert!(forwards_to_upstream(&hn(h)), "{h} must be forwarded");
        }
    }

    #[tokio::test]
    async fn anthropic_fallback_failure_returns_502() {
        let resp = fallback_failure_response("connection refused", "", "", &[]);
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"]["type"], "api_error");
    }

    #[test]
    fn origin_on_private_lan_ip_is_not_trusted() {
        let none: Vec<Vec<String>> = vec![];
        assert!(origin_is_trusted("http://localhost:3000", &none));
        assert!(origin_is_trusted("http://127.0.0.1:5173", &none));
        assert!(!origin_is_trusted("http://192.168.1.5:3000", &none));
        assert!(!origin_is_trusted("http://10.0.0.2", &none));
        assert!(origin_is_trusted("http://192.168.1.5:3000", &[vec!["192.168.1.5".into()]]));
    }
}

#[cfg(test)]
mod provider_routing_tests {
    use super::*;

    fn provider(name: &str, models: &[&str]) -> (String, ProviderConfig) {
        (
            name.to_string(),
            ProviderConfig {
                provider: name.to_string(),
                models: models.iter().map(|m| m.to_string()).collect(),
                ..Default::default()
            },
        )
    }

    #[test]
    fn bare_model_id_with_two_providers_is_deterministic() {
        let pc: HashMap<_, _> =
            [provider("zeta", &["shared"]), provider("alpha", &["shared"]), provider("mid", &["other"])]
                .into_iter()
                .collect();
        for _ in 0..20 {
            assert_eq!(resolve_provider_name(&pc, "shared").as_deref(), Some("alpha"));
        }
        assert_eq!(resolve_provider_name(&pc, "other").as_deref(), Some("mid"));
        assert_eq!(resolve_provider_name(&pc, "unknown"), None);
    }

    #[test]
    fn prefix_model_id_routes_to_named_provider() {
        let pc: HashMap<_, _> = [
            provider("alpha", &["zeta/shared"]),
            provider("zeta", &["zeta/shared"]),
            provider("openai", &[]),
        ]
        .into_iter()
        .collect();
        // Both list the id; the prefix names zeta, so it wins over the sort order.
        assert_eq!(resolve_provider_name(&pc, "zeta/shared").as_deref(), Some("zeta"));
        // Nobody lists it, but the prefix names a configured provider.
        assert_eq!(resolve_provider_name(&pc, "openai/gpt-x").as_deref(), Some("openai"));
    }
}

#[cfg(test)]
mod request_check_tests {
    use super::*;

    fn config(key: &str) -> ProxyConfig {
        ProxyConfig {
            prefix: "/v1".into(),
            proxy_api_key: key.into(),
            trusted_hosts: vec![],
            host: "127.0.0.1".into(),
            port: 1337,
            enable_server_tool_execution: false,
            cors_enabled: true,
        }
    }

    fn parts(uri: &str, headers: &[(&str, &str)]) -> hyper::http::request::Parts {
        let mut builder = Request::builder().uri(uri);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        builder.body(()).unwrap().into_parts().0
    }

    fn status_of(refusal: Option<Response<ResBody>>) -> Option<u16> {
        refusal.map(|r| r.status().as_u16())
    }

    #[test]
    fn host_origin_and_key_are_checked_in_that_order() {
        let cfg = config("secret");
        // Foreign host: refused before the key is even looked at.
        let p = parts("/v1/models", &[("host", "evil.example"), ("authorization", "Bearer secret")]);
        assert_eq!(status_of(check_request(&p, "/models", "evil.example", "", &cfg)), Some(403));
        // No host header at all.
        let p = parts("/v1/models", &[]);
        assert_eq!(status_of(check_request(&p, "/models", "", "", &cfg)), Some(400));
        // Good host, no key.
        let p = parts("/v1/models", &[("host", "127.0.0.1:1337")]);
        assert_eq!(status_of(check_request(&p, "/models", "127.0.0.1:1337", "", &cfg)), Some(401));
        // Good host, wrong key, then the right one in either header.
        let p = parts("/v1/models", &[("host", "127.0.0.1:1337"), ("authorization", "Bearer nope")]);
        assert_eq!(status_of(check_request(&p, "/models", "127.0.0.1:1337", "", &cfg)), Some(401));
        let p = parts("/v1/models", &[("host", "127.0.0.1:1337"), ("authorization", "Bearer secret")]);
        assert_eq!(status_of(check_request(&p, "/models", "127.0.0.1:1337", "", &cfg)), None);
        let p = parts("/v1/models", &[("host", "127.0.0.1:1337"), ("x-api-key", "secret")]);
        assert_eq!(status_of(check_request(&p, "/models", "127.0.0.1:1337", "", &cfg)), None);
    }

    #[test]
    fn a_foreign_origin_is_refused_when_no_key_is_set() {
        let cfg = config("");
        let p = parts("/v1/models", &[("host", "127.0.0.1:1337"), ("origin", "https://evil.example")]);
        assert_eq!(
            status_of(check_request(&p, "/models", "127.0.0.1:1337", "https://evil.example", &cfg)),
            Some(403)
        );
        // No origin (curl, an SDK): fine.
        let p = parts("/v1/models", &[("host", "127.0.0.1:1337")]);
        assert_eq!(status_of(check_request(&p, "/models", "127.0.0.1:1337", "", &cfg)), None);
    }

    #[test]
    fn whitelisted_paths_skip_the_host_and_key_checks_and_configs_is_hidden() {
        let cfg = config("secret");
        let p = parts("/", &[]);
        assert_eq!(status_of(check_request(&p, "/", "", "", &cfg)), None);
        assert_eq!(status_of(check_request(&p, "/openapi.json", "", "", &cfg)), None);
        let p = parts("/v1/configs", &[("host", "127.0.0.1:1337"), ("authorization", "Bearer secret")]);
        assert_eq!(status_of(check_request(&p, "/configs", "127.0.0.1:1337", "", &cfg)), Some(404));
    }

    #[test]
    fn quota_refusal_ignores_unmetered_requests() {
        let cfg = config("");
        let none = quota_refusal(&hyper::Method::GET, "/models", "", "", &cfg, "no-such-folder");
        assert!(none.is_none());
        let none = quota_refusal(&hyper::Method::POST, "/embeddings", "", "", &cfg, "no-such-folder");
        assert!(none.is_none());
    }
}


#[cfg(test)]
mod golden_tests {
    use serde_json::{json, Value};

    async fn stream_events(chunks: Vec<&'static [u8]>) -> Value {
        use http_body_util::BodyExt;
        use hyper::body::Bytes;
        let chunks: Vec<Result<Bytes, reqwest::Error>> =
            chunks.into_iter().map(|c| Ok(Bytes::from_static(c))).collect();
        let (sender, body) = super::body_channel();
        let run = super::transform_and_forward_stream(futures_util::stream::iter(chunks), sender, "/v1/messages");
        let (_, out) = tokio::join!(run, body.collect());
        let out = out.unwrap().to_bytes();
        let text = String::from_utf8(out.to_vec()).unwrap();
        // Each event kept as its raw text: byte-equal, not merely
        // value-equal, output is what the refactor must preserve.
        Value::Array(text.split_inclusive("\n\n").map(|e| json!(e)).collect())
    }

    #[tokio::test]
    async fn golden_anthropic_stream_output() {
        let cases: Vec<(&str, Vec<&'static [u8]>)> = vec![
            ("stream_text_usage", vec![
                b"data: {\"id\":\"m1\",\"model\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"},\"finish_reason\":null}]}\n\n",
                b"data: {\"choices\":[{\"delta\":{\"content\":\"lo there\"},\"finish_reason\":null}]}\n\n",
                b": keepalive\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"\"},\"finish_reason\":\"stop\"}]}\n\n",
                b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":3,\"prompt_tokens_details\":{\"cached_tokens\":2}}}\n\n",
                b"data: [DONE]\n\n",
            ]),
            ("stream_text_then_tools", vec![
                b"data: {\"id\":\"m2\",\"model\":\"y\",\"choices\":[{\"delta\":{\"content\":\"let me\"}}]}\n\n",
                b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"t1\",\"function\":{\"name\":\"read\",\"arguments\":\"\"}}]}}]}\n\n",
                b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"p\\\":\"}}]}}]}\n\n",
                b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"t2\",\"function\":{\"name\":\"ls\",\"arguments\":\"{}\"}},{\"index\":0,\"function\":{\"arguments\":\"1}\"}}]}}]}\n\n",
                b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":5,\"function\":{\"arguments\":\"lost\"}}]}}]}\n\n",
                b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                b"data: [DONE]\n\n",
            ]),
            ("stream_split_utf8_and_lines", vec![
                b"data: {\"id\":\"m3\",\"choices\":[{\"delta\":{\"content\":\"caf\xc3",
                b"\xa9 \xe2\x9c",
                b"\x93\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" ok\"},\"finish_reason\":\"length\"}]}",
            ]),
            ("stream_no_finish", vec![
                b"data: {\"id\":\"m4\",\"choices\":[{\"delta\":{\"content\":\"partial words here\"}}]}\n\n",
                b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"t9\",\"function\":{\"name\":\"x\"}}]}}]}\n\n",
                b"data: not json\n\n",
                b"data: {\"choices\":[]}\n\n",
            ]),
            ("stream_empty", vec![]),
            ("stream_only_garbage", vec![b"event: ping\n\n", b"data: [DONE]\n\n"]),
        ];
        for (name, chunks) in cases {
            crate::core::server::golden::check(name, &stream_events(chunks).await);
        }
    }

    #[test]
    fn golden_convert_messages() {
        let messages = json!([
            {"role": "user", "content": "plain"},
            {"role": "tool", "content": "skipped role"},
            {"role": "system", "content": "inline system"},
            {"role": "assistant", "content": [
                {"type": "text", "text": "a1"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
                {"type": "tool_use", "id": "u1", "name": "read", "input": {"p": 1}},
                {"type": "tool_use", "id": "u2", "name": "bad"},
                {"type": "thinking", "thinking": "hm"}
            ]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "u3", "name": "ls", "input": {}}
            ]},
            {"role": "assistant", "content": [{"type": "text", "text": "only text"}]},
            {"role": "assistant", "content": []},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "u1", "content": "fine"},
                {"type": "tool_result", "tool_use_id": "u3", "is_error": true, "content": [
                    {"type": "text", "text": "boom"},
                    {"type": "image", "source": {"type": "url", "url": "https://x.test/i.png"}}
                ]},
                {"type": "tool_result", "content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]},
                {"type": "text", "text": "and then"},
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBE"}}
            ]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "u2"}]},
            {"role": "developer", "content": [{"type": "text", "text": "d1"}, {"type": "text", "text": "d2"}]},
            {"role": "other", "content": [{"type": "text", "text": "x"}]}
        ]);
        let cases = vec![
            ("convert_messages_string_system", Some(json!("top system"))),
            ("convert_messages_block_system", Some(json!([{"type": "text", "text": "s1"}, {"type": "x"}, {"type": "text", "text": "s2"}]))),
            ("convert_messages_empty_block_system", Some(json!([{"type": "x"}]))),
            ("convert_messages_no_system", None),
        ];
        for (name, system) in cases {
            let out = super::convert_messages(&messages, system.as_ref());
            crate::core::server::golden::check(name, &json!(out));
        }
        // A malformed message ends the conversion with `None`.
        crate::core::server::golden::check(
            "convert_messages_malformed",
            &json!([
                super::convert_messages(&json!([{"content": "no role"}]), None),
                super::convert_messages(&json!([{"role": "user", "content": 5}]), None),
                super::convert_messages(&json!({"not": "array"}), None),
            ]),
        );
    }
}
