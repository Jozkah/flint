//! `POST /v1/responses`: an OpenAI Responses-API front for the chat path.
//!
//! Tools that speak the Responses wire format (Codex, the OpenAI SDKs'
//! `responses.create`) can point at the local server. The request is rewritten
//! into a chat/completions body, sent to this server's own `/chat/completions`
//! (so routing, local engines, provider converters, quotas and keys all behave
//! exactly as for any other client) and the answer is rewritten back, whole or
//! as the Responses server-sent events.
//!
//! The route is stateless. `previous_response_id` and `item_reference` are
//! refused with a clear error rather than half-working; send the full `input`.
//! Tool types other than `function` (hosted search, shell, ...) are not
//! offered to the model, since nothing here could run them.

use std::convert::Infallible;

use futures_util::StreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::StatusCode;
use serde_json::{json, Map, Value};

/// A `400` for something the request asked that this route cannot do.
#[derive(Debug, PartialEq)]
pub struct Unsupported(pub String);

fn short_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn text_of_parts(content: &Value) -> Result<Value, Unsupported> {
    // A plain string stays a string; parts become chat content parts.
    let Some(parts) = content.as_array() else {
        return Ok(content.clone());
    };
    let mut out: Vec<Value> = Vec::new();
    for p in parts {
        match p.get("type").and_then(Value::as_str).unwrap_or("") {
            "input_text" | "output_text" | "text" => {
                out.push(json!({ "type": "text", "text": p.get("text").and_then(Value::as_str).unwrap_or("") }))
            }
            "input_image" => {
                let url = match p.get("image_url") {
                    Some(Value::String(s)) => s.clone(),
                    Some(o) => o.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
                    None => String::new(),
                };
                if url.is_empty() {
                    return Err(Unsupported("an input_image needs an image_url (file_id images are not supported)".into()));
                }
                out.push(json!({ "type": "image_url", "image_url": { "url": url } }));
            }
            "refusal" => out.push(json!({ "type": "text", "text": p.get("refusal").and_then(Value::as_str).unwrap_or("") })),
            other => return Err(Unsupported(format!("input content of type \"{other}\" is not supported"))),
        }
    }
    // Text-only content is sent as one string, which every backend takes.
    if out.iter().all(|p| p["type"] == "text") {
        let joined: String = out.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n");
        return Ok(Value::String(joined));
    }
    Ok(Value::Array(out))
}

fn role_of(role: &str) -> &str {
    match role {
        "developer" => "system",
        r => r,
    }
}

/// A Responses request as a chat/completions body.
pub fn request_to_chat(req: &Value) -> Result<Value, Unsupported> {
    let obj = req.as_object().ok_or_else(|| Unsupported("the body must be a JSON object".into()))?;
    let model = obj.get("model").and_then(Value::as_str).filter(|m| !m.is_empty());
    let model = model.ok_or_else(|| Unsupported("`model` is required".into()))?;
    if obj.get("previous_response_id").is_some_and(|v| !v.is_null()) {
        return Err(Unsupported(
            "previous_response_id is not supported: this server keeps no response state. Send the full conversation in `input`.".into(),
        ));
    }
    let mut messages: Vec<Value> = Vec::new();
    if let Some(ins) = obj.get("instructions").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": ins }));
    }
    match obj.get("input") {
        Some(Value::String(s)) => messages.push(json!({ "role": "user", "content": s })),
        Some(Value::Array(items)) => {
            for item in items {
                let kind = item.get("type").and_then(Value::as_str).unwrap_or("message");
                match kind {
                    "message" => {
                        let role = role_of(item.get("role").and_then(Value::as_str).unwrap_or("user"));
                        let content = text_of_parts(item.get("content").unwrap_or(&Value::Null))?;
                        messages.push(json!({ "role": role, "content": content }));
                    }
                    "function_call" => {
                        let call = json!({
                            "id": item.get("call_id").and_then(Value::as_str).unwrap_or(""),
                            "type": "function",
                            "function": {
                                "name": item.get("name").and_then(Value::as_str).unwrap_or(""),
                                "arguments": item.get("arguments").and_then(Value::as_str).unwrap_or("{}"),
                            }
                        });
                        // Consecutive calls from one turn share an assistant message.
                        // They also join an assistant text message just before them.
                        match messages.last_mut() {
                            Some(last) if last["role"] == "assistant" => {
                                if last.get("tool_calls").is_none() {
                                    last["tool_calls"] = json!([]);
                                }
                                if let Some(a) = last["tool_calls"].as_array_mut() {
                                    a.push(call);
                                }
                            }
                            _ => messages.push(json!({ "role": "assistant", "content": null, "tool_calls": [call] })),
                        }
                    }
                    "function_call_output" => {
                        let output = match item.get("output") {
                            Some(Value::String(s)) => s.clone(),
                            // The item-list form: keep its text parts as plain text.
                            Some(Value::Array(parts)) => {
                                let text: Vec<&str> = parts
                                    .iter()
                                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                                    .collect();
                                if text.is_empty() { Value::Array(parts.clone()).to_string() } else { text.join("
") }
                            }
                            Some(other) => other.to_string(),
                            None => String::new(),
                        };
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": item.get("call_id").and_then(Value::as_str).unwrap_or(""),
                            "content": output,
                        }));
                    }
                    "reasoning" => {}
                    other => return Err(Unsupported(format!("input item of type \"{other}\" is not supported"))),
                }
            }
        }
        _ => return Err(Unsupported("`input` must be a string or an array of items".into())),
    }
    if messages.is_empty() {
        return Err(Unsupported("`input` is empty".into()));
    }
    let mut chat = Map::new();
    chat.insert("model".into(), json!(model));
    chat.insert("messages".into(), Value::Array(messages));
    let stream = obj.get("stream").and_then(Value::as_bool).unwrap_or(false);
    chat.insert("stream".into(), json!(stream));
    if stream {
        chat.insert("stream_options".into(), json!({ "include_usage": true }));
    }
    for (from, to) in [("temperature", "temperature"), ("top_p", "top_p"), ("max_output_tokens", "max_tokens"), ("parallel_tool_calls", "parallel_tool_calls")] {
        if let Some(v) = obj.get(from).filter(|v| !v.is_null()) {
            chat.insert(to.into(), v.clone());
        }
    }
    if let Some(effort) = obj.get("reasoning").and_then(|r| r.get("effort")).and_then(Value::as_str) {
        chat.insert("reasoning_effort".into(), json!(effort));
    }
    if let Some(tools) = obj.get("tools").and_then(Value::as_array) {
        let fns: Vec<Value> = tools
            .iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("function"))
            .map(|t| {
                let mut f = Map::new();
                f.insert("name".into(), t.get("name").cloned().unwrap_or(json!("")));
                if let Some(d) = t.get("description") {
                    f.insert("description".into(), d.clone());
                }
                f.insert("parameters".into(), t.get("parameters").cloned().unwrap_or(json!({ "type": "object", "properties": {} })));
                json!({ "type": "function", "function": f })
            })
            .collect();
        if !fns.is_empty() {
            chat.insert("tools".into(), Value::Array(fns));
            match obj.get("tool_choice") {
                Some(Value::String(s)) => {
                    chat.insert("tool_choice".into(), json!(s));
                }
                Some(o) if o.get("type").and_then(Value::as_str) == Some("function") => {
                    chat.insert("tool_choice".into(), json!({ "type": "function", "function": { "name": o["name"] } }));
                }
                _ => {}
            }
        }
    }
    if let Some(fmt) = obj.get("text").and_then(|t| t.get("format")) {
        match fmt.get("type").and_then(Value::as_str) {
            Some("json_schema") => {
                chat.insert(
                    "response_format".into(),
                    json!({ "type": "json_schema", "json_schema": {
                        "name": fmt.get("name").cloned().unwrap_or(json!("response")),
                        "schema": fmt.get("schema").cloned().unwrap_or(json!({})),
                        "strict": fmt.get("strict").cloned().unwrap_or(json!(false)),
                    } }),
                );
            }
            Some("json_object") => {
                chat.insert("response_format".into(), json!({ "type": "json_object" }));
            }
            _ => {}
        }
    }
    Ok(Value::Object(chat))
}

fn usage_of(chat_usage: &Value) -> Value {
    let get = |k: &str| chat_usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let (input, output) = (get("prompt_tokens"), get("completion_tokens"));
    json!({
        "input_tokens": input,
        "input_tokens_details": { "cached_tokens": chat_usage["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0) },
        "output_tokens": output,
        "output_tokens_details": { "reasoning_tokens": chat_usage["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0) },
        "total_tokens": chat_usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(input + output),
    })
}

/// The request fields a Responses object echoes back.
fn echo(req: &Value) -> Map<String, Value> {
    let mut m = Map::new();
    for k in ["instructions", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "max_output_tokens", "metadata", "user"] {
        m.insert(k.into(), req.get(k).cloned().unwrap_or(Value::Null));
    }
    m.insert("text".into(), req.get("text").cloned().unwrap_or(json!({ "format": { "type": "text" } })));
    m.insert("store".into(), json!(false));
    m.insert("previous_response_id".into(), Value::Null);
    m.insert("error".into(), Value::Null);
    m
}

#[allow(clippy::too_many_arguments)]
fn response_object(req: &Value, id: &str, created: u64, model: &str, status: &str, output: Vec<Value>, usage: Option<Value>, incomplete: Option<&str>) -> Value {
    let mut o = echo(req);
    o.insert("id".into(), json!(id));
    o.insert("object".into(), json!("response"));
    o.insert("created_at".into(), json!(created));
    o.insert("status".into(), json!(status));
    o.insert("model".into(), json!(model));
    o.insert("output".into(), Value::Array(output));
    o.insert("usage".into(), usage.unwrap_or(Value::Null));
    o.insert("incomplete_details".into(), incomplete.map(|r| json!({ "reason": r })).unwrap_or(Value::Null));
    Value::Object(o)
}

fn message_item(id: &str, text: &str, status: &str) -> Value {
    json!({
        "id": id, "type": "message", "status": status, "role": "assistant",
        "content": [{ "type": "output_text", "text": text, "annotations": [] }],
    })
}

fn call_item(id: &str, call_id: &str, name: &str, args: &str, status: &str) -> Value {
    json!({ "id": id, "type": "function_call", "status": status, "call_id": call_id, "name": name, "arguments": args })
}

/// Why a chat `finish_reason` leaves the response `incomplete`, if it does.
fn incomplete_reason(finish_reason: Option<&str>) -> Option<&'static str> {
    match finish_reason {
        Some("length") => Some("max_output_tokens"),
        Some("content_filter") => Some("content_filter"),
        _ => None,
    }
}

fn reasoning_item(id: &str, text: &str) -> Value {
    json!({ "id": id, "type": "reasoning", "summary": [{ "type": "summary_text", "text": text }] })
}

/// A whole chat/completions answer as a Responses object.
pub fn chat_to_response(req: &Value, chat: &Value) -> Value {
    let choice = &chat["choices"][0];
    let msg = &choice["message"];
    let mut output = Vec::new();
    if let Some(r) = msg["reasoning_content"].as_str().filter(|r| !r.is_empty()) {
        output.push(reasoning_item(&short_id("rs"), r));
    }
    let text = match &msg["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    };
    if !text.is_empty() {
        output.push(message_item(&short_id("msg"), &text, "completed"));
    }
    for c in msg["tool_calls"].as_array().cloned().unwrap_or_default() {
        output.push(call_item(
            &short_id("fc"),
            c["id"].as_str().unwrap_or(""),
            c["function"]["name"].as_str().unwrap_or(""),
            c["function"]["arguments"].as_str().unwrap_or("{}"),
            "completed",
        ));
    }
    let incomplete = incomplete_reason(choice["finish_reason"].as_str());
    let model = chat["model"].as_str().or_else(|| req["model"].as_str()).unwrap_or("");
    let created = chat["created"].as_u64().unwrap_or_else(now_secs);
    response_object(
        req,
        &short_id("resp"),
        created,
        model,
        if incomplete.is_some() { "incomplete" } else { "completed" },
        output,
        chat.get("usage").filter(|u| u.is_object()).map(usage_of),
        incomplete,
    )
}

fn sse(event: &str, mut data: Value, seq: &mut u64) -> String {
    data["type"] = json!(event);
    data["sequence_number"] = json!(*seq);
    *seq += 1;
    format!("event: {event}\ndata: {data}\n\n")
}

struct OpenText {
    item_id: String,
    output_index: usize,
    text: String,
}

struct OpenCall {
    chat_index: u64,
    item_id: String,
    output_index: usize,
    call_id: String,
    name: String,
    args: String,
}

/// Chat completion chunks in, Responses events out.
pub struct StreamMapper {
    req: Value,
    id: String,
    created: u64,
    model: String,
    seq: u64,
    started: bool,
    next_output: usize,
    reasoning: Option<OpenText>,
    text: Option<OpenText>,
    calls: Vec<OpenCall>,
    done_items: Vec<(usize, Value)>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    finished: bool,
}

impl StreamMapper {
    pub fn new(req: &Value) -> Self {
        StreamMapper {
            req: req.clone(),
            id: short_id("resp"),
            created: now_secs(),
            model: req["model"].as_str().unwrap_or("").to_string(),
            seq: 0,
            started: false,
            next_output: 0,
            reasoning: None,
            text: None,
            calls: Vec::new(),
            done_items: Vec::new(),
            finish_reason: None,
            usage: None,
            finished: false,
        }
    }

    fn snapshot(&self, status: &str, output: Vec<Value>, usage: Option<Value>, incomplete: Option<&str>) -> Value {
        response_object(&self.req, &self.id, self.created, &self.model, status, output, usage, incomplete)
    }

    fn start(&mut self, out: &mut Vec<String>) {
        if self.started {
            return;
        }
        self.started = true;
        let snap = self.snapshot("in_progress", vec![], None, None);
        out.push(sse("response.created", json!({ "response": snap.clone() }), &mut self.seq));
        out.push(sse("response.in_progress", json!({ "response": snap }), &mut self.seq));
    }

    fn close_reasoning(&mut self, out: &mut Vec<String>) {
        let Some(r) = self.reasoning.take() else { return };
        let part = json!({ "type": "summary_text", "text": r.text });
        out.push(sse(
            "response.reasoning_summary_text.done",
            json!({ "item_id": r.item_id, "output_index": r.output_index, "summary_index": 0, "text": r.text }),
            &mut self.seq,
        ));
        out.push(sse(
            "response.reasoning_summary_part.done",
            json!({ "item_id": r.item_id, "output_index": r.output_index, "summary_index": 0, "part": part }),
            &mut self.seq,
        ));
        let item = reasoning_item(&r.item_id, &r.text);
        out.push(sse("response.output_item.done", json!({ "output_index": r.output_index, "item": item.clone() }), &mut self.seq));
        self.done_items.push((r.output_index, item));
    }

    fn push_reasoning(&mut self, text: &str, out: &mut Vec<String>) {
        if self.reasoning.is_none() {
            let item_id = short_id("rs");
            let output_index = self.next_output;
            self.next_output += 1;
            out.push(sse(
                "response.output_item.added",
                json!({ "output_index": output_index, "item": { "id": item_id, "type": "reasoning", "summary": [] } }),
                &mut self.seq,
            ));
            out.push(sse(
                "response.reasoning_summary_part.added",
                json!({ "item_id": item_id, "output_index": output_index, "summary_index": 0, "part": { "type": "summary_text", "text": "" } }),
                &mut self.seq,
            ));
            self.reasoning = Some(OpenText { item_id, output_index, text: String::new() });
        }
        if let Some(r) = self.reasoning.as_mut() {
            r.text.push_str(text);
            out.push(sse(
                "response.reasoning_summary_text.delta",
                json!({ "item_id": r.item_id, "output_index": r.output_index, "summary_index": 0, "delta": text }),
                &mut self.seq,
            ));
        }
    }

    fn close_text(&mut self, out: &mut Vec<String>) {
        let Some(t) = self.text.take() else { return };
        let part = json!({ "type": "output_text", "text": t.text, "annotations": [] });
        out.push(sse(
            "response.output_text.done",
            json!({ "item_id": t.item_id, "output_index": t.output_index, "content_index": 0, "text": t.text }),
            &mut self.seq,
        ));
        out.push(sse(
            "response.content_part.done",
            json!({ "item_id": t.item_id, "output_index": t.output_index, "content_index": 0, "part": part }),
            &mut self.seq,
        ));
        let item = message_item(&t.item_id, &t.text, "completed");
        out.push(sse("response.output_item.done", json!({ "output_index": t.output_index, "item": item.clone() }), &mut self.seq));
        self.done_items.push((t.output_index, item));
    }

    fn close_calls(&mut self, out: &mut Vec<String>) {
        for c in std::mem::take(&mut self.calls) {
            out.push(sse(
                "response.function_call_arguments.done",
                json!({ "item_id": c.item_id, "output_index": c.output_index, "arguments": c.args }),
                &mut self.seq,
            ));
            let item = call_item(&c.item_id, &c.call_id, &c.name, &c.args, "completed");
            out.push(sse("response.output_item.done", json!({ "output_index": c.output_index, "item": item.clone() }), &mut self.seq));
            self.done_items.push((c.output_index, item));
        }
    }

    /// One `data:` payload of the chat stream.
    pub fn feed(&mut self, data: &str) -> Vec<String> {
        let mut out = Vec::new();
        let data = data.trim();
        if data.is_empty() || self.finished {
            return out;
        }
        if data == "[DONE]" {
            return self.finish();
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { return out };
        if let Some(err) = chunk.get("error").filter(|e| !e.is_null()) {
            return self.fail(&err["code"], err["message"].as_str().unwrap_or("the model call failed"));
        }
        self.start(&mut out);
        if let Some(m) = chunk["model"].as_str().filter(|m| !m.is_empty()) {
            self.model = m.to_string();
        }
        if let Some(u) = chunk.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(usage_of(u));
        }
        let choice = &chunk["choices"][0];
        if let Some(r) = choice["finish_reason"].as_str() {
            self.finish_reason = Some(r.to_string());
        }
        let delta = &choice["delta"];
        if let Some(r) = delta["reasoning_content"].as_str().filter(|t| !t.is_empty()) {
            self.push_reasoning(r, &mut out);
        }
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            // Reasoning ends where the answer begins.
            self.close_reasoning(&mut out);
            if self.text.is_none() {
                let item_id = short_id("msg");
                let output_index = self.next_output;
                self.next_output += 1;
                out.push(sse(
                    "response.output_item.added",
                    json!({ "output_index": output_index, "item": { "id": item_id, "type": "message", "status": "in_progress", "role": "assistant", "content": [] } }),
                    &mut self.seq,
                ));
                out.push(sse(
                    "response.content_part.added",
                    json!({ "item_id": item_id, "output_index": output_index, "content_index": 0, "part": { "type": "output_text", "text": "", "annotations": [] } }),
                    &mut self.seq,
                ));
                self.text = Some(OpenText { item_id, output_index, text: String::new() });
            }
            if let Some(t) = self.text.as_mut() {
                t.text.push_str(text);
                out.push(sse(
                    "response.output_text.delta",
                    json!({ "item_id": t.item_id, "output_index": t.output_index, "content_index": 0, "delta": text }),
                    &mut self.seq,
                ));
            }
        }
        for tc in delta["tool_calls"].as_array().cloned().unwrap_or_default() {
            // Text ends where the calls begin.
            self.close_reasoning(&mut out);
            self.close_text(&mut out);
            let index = tc["index"].as_u64().unwrap_or(0);
            if !self.calls.iter().any(|c| c.chat_index == index) {
                let item_id = short_id("fc");
                let output_index = self.next_output;
                self.next_output += 1;
                let call_id = tc["id"].as_str().unwrap_or("").to_string();
                let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                out.push(sse(
                    "response.output_item.added",
                    json!({ "output_index": output_index, "item": call_item(&item_id, &call_id, &name, "", "in_progress") }),
                    &mut self.seq,
                ));
                self.calls.push(OpenCall { chat_index: index, item_id, output_index, call_id, name, args: String::new() });
            }
            if let Some(c) = self.calls.iter_mut().find(|c| c.chat_index == index) {
                if c.name.is_empty() {
                    c.name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                }
                if let Some(a) = tc["function"]["arguments"].as_str().filter(|a| !a.is_empty()) {
                    c.args.push_str(a);
                    out.push(sse(
                        "response.function_call_arguments.delta",
                        json!({ "item_id": c.item_id, "output_index": c.output_index, "delta": a }),
                        &mut self.seq,
                    ));
                }
            }
        }
        out
    }

    /// The response failed: an `error` event and `response.failed`, never `response.completed`.
    pub fn fail(&mut self, code: &Value, message: &str) -> Vec<String> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        self.start(&mut out);
        self.finished = true;
        let mut resp = self.snapshot("failed", vec![], None, None);
        resp["error"] = json!({ "code": code.as_str().unwrap_or("server_error"), "message": message });
        out.push(sse("error", json!({ "code": code, "message": message, "param": null }), &mut self.seq));
        out.push(sse("response.failed", json!({ "response": resp }), &mut self.seq));
        out
    }

    /// The end of the chat stream: close what is open and complete the response.
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        self.finished = true;
        self.start(&mut out);
        self.close_reasoning(&mut out);
        self.close_text(&mut out);
        self.close_calls(&mut out);
        let mut items = std::mem::take(&mut self.done_items);
        items.sort_by_key(|(i, _)| *i);
        let output: Vec<Value> = items.into_iter().map(|(_, v)| v).collect();
        let incomplete = incomplete_reason(self.finish_reason.as_deref());
        let snap = self.snapshot(if incomplete.is_some() { "incomplete" } else { "completed" }, output, self.usage.clone(), incomplete);
        let event = if incomplete.is_some() { "response.incomplete" } else { "response.completed" };
        out.push(sse(event, json!({ "response": snap }), &mut self.seq));
        out
    }
}

/// What the route answers with; the proxy adds its CORS headers.
pub struct Handled {
    pub status: StatusCode,
    pub content_type: &'static str,
    pub body: BoxBody<Bytes, Infallible>,
}

fn json_body(status: StatusCode, v: Value) -> Handled {
    Handled { status, content_type: "application/json", body: Full::new(Bytes::from(v.to_string())).boxed() }
}

fn error(status: StatusCode, message: &str, kind: &str, code: &str) -> Handled {
    json_body(status, json!({ "error": { "message": message, "type": kind, "code": code } }))
}

/// The address the inner chat call uses: this server, on loopback.
pub fn loopback_url(host: &str, port: u16, prefix: &str) -> String {
    let host = match host.trim() {
        "" | "0.0.0.0" | "::" | "[::]" | "localhost" => "127.0.0.1",
        h => h,
    };
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    format!("http://{host}:{port}{prefix}/chat/completions")
}

/// Answer one `/responses` request by calling this server's own chat route.
pub async fn handle(body: &[u8], headers: &hyper::HeaderMap, url: &str, client: &reqwest::Client) -> Handled {
    let Ok(req) = serde_json::from_slice::<Value>(body) else {
        return error(StatusCode::BAD_REQUEST, "the request body is not valid JSON", "invalid_request_error", "invalid_json");
    };
    // A missing model is a missing parameter, not an unsupported one, and
    // names it the way OpenAI does so clients can point at the field.
    if req.is_object() && req.get("model").and_then(Value::as_str).is_none_or(|m| m.trim().is_empty()) {
        return json_body(
            StatusCode::BAD_REQUEST,
            json!({ "error": {
                "message": "`model` is required",
                "type": "invalid_request_error",
                "param": "model",
                "code": "missing_required_parameter",
            } }),
        );
    }
    let chat = match request_to_chat(&req) {
        Ok(c) => c,
        Err(Unsupported(why)) => return error(StatusCode::BAD_REQUEST, &why, "invalid_request_error", "unsupported_parameter"),
    };
    let stream = chat["stream"].as_bool().unwrap_or(false);
    let mut call = client.post(url).header("Content-Type", "application/json").body(chat.to_string());
    for name in ["authorization", "x-api-key", "api-key", "host", "origin"] {
        if let Some(v) = headers.get(name) {
            call = call.header(name, v.as_bytes());
        }
    }
    let upstream = match call.send().await {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_GATEWAY, &format!("the chat route did not answer: {e}"), "api_error", "upstream_unreachable"),
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if !status.is_success() {
        let text = upstream.text().await.unwrap_or_default();
        let body = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({ "error": { "message": text, "type": "api_error", "code": "upstream_error" } }));
        return json_body(status, body);
    }
    if !stream {
        let text = upstream.text().await.unwrap_or_default();
        return match serde_json::from_str::<Value>(&text) {
            Ok(chat) => json_body(StatusCode::OK, chat_to_response(&req, &chat)),
            Err(_) => error(StatusCode::BAD_GATEWAY, "the model answered with something that is not JSON", "api_error", "bad_upstream_response"),
        };
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Frame<Bytes>, Infallible>>(32);
    tokio::spawn(pump(req, upstream.bytes_stream(), tx));
    Handled {
        status: StatusCode::OK,
        content_type: "text/event-stream",
        body: BodyExt::boxed(StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(rx))),
    }
}

/// Maps the upstream chat stream onto Responses events. A transport error mid-stream fails the
/// response instead of completing it with whatever arrived so far.
async fn pump<S, E>(req: Value, bytes: S, tx: tokio::sync::mpsc::Sender<Result<Frame<Bytes>, Infallible>>)
where
    S: futures_util::Stream<Item = Result<Bytes, E>>,
    E: std::fmt::Display,
{
    let mut bytes = std::pin::pin!(bytes);
    let mut mapper = StreamMapper::new(&req);
    let mut buf: Vec<u8> = Vec::new();
    let send = |events: Vec<String>| {
        let tx = tx.clone();
        async move {
            for e in events {
                if tx.send(Ok(Frame::data(Bytes::from(e)))).await.is_err() {
                    return false;
                }
            }
            true
        }
    };
    while let Some(chunk) = bytes.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = send(mapper.fail(&json!("upstream_stream_error"), &format!("the chat stream broke off: {e}"))).await;
                return;
            }
        };
        buf.extend_from_slice(&chunk);
        while let Some((end, skip)) = event_end(&buf) {
            let raw: Vec<u8> = buf.drain(..end + skip).collect();
            let event = String::from_utf8_lossy(&raw[..end]).into_owned();
            let data: Vec<&str> = event.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect();
            if !data.is_empty() && !send(mapper.feed(&data.join("
"))).await {
                return;
            }
        }
    }
    let _ = send(mapper.finish()).await;
}

/// Where the first complete SSE event in `buf` ends, and how many separator bytes follow.
fn event_end(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|p| (p, 2));
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| (p, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn assistant_text_and_calls_merge_and_array_output_is_text() {
        let req = json!({"model": "m", "input": [
            {"type": "message", "role": "user", "content": "hi"},
            {"type": "message", "role": "assistant", "content": "checking"},
            {"type": "function_call", "call_id": "c1", "name": "f", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "c1", "output": [{"type": "output_text", "text": "done"}]},
        ]});
        let chat = request_to_chat(&req).unwrap();
        let msgs = chat["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["tool_calls"].as_array().unwrap().len(), 1);
        assert_eq!(msgs[2]["content"], "done");
    }

    use super::*;

    fn events(raw: &[String]) -> Vec<(String, Value)> {
        raw.iter()
            .map(|e| {
                let ev = e.lines().next().unwrap().trim_start_matches("event: ").to_string();
                let data = e.lines().nth(1).unwrap().trim_start_matches("data: ");
                (ev, serde_json::from_str(data).unwrap())
            })
            .collect()
    }

    #[test]
    fn a_string_input_becomes_one_user_message_with_instructions_first() {
        let chat = request_to_chat(&json!({ "model": "m", "input": "hi", "instructions": "be brief", "max_output_tokens": 50, "temperature": 0.2 })).unwrap();
        assert_eq!(chat["messages"], json!([{ "role": "system", "content": "be brief" }, { "role": "user", "content": "hi" }]));
        assert_eq!((chat["max_tokens"].as_u64(), chat["temperature"].as_f64(), chat["stream"].as_bool()), (Some(50), Some(0.2), Some(false)));
    }

    #[test]
    fn items_map_to_roles_tool_calls_and_tool_results() {
        let chat = request_to_chat(&json!({
            "model": "m",
            "input": [
                { "role": "developer", "content": "rules" },
                { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "read it" }, { "type": "input_image", "image_url": "data:image/png;base64,AA==" }] },
                { "type": "reasoning", "summary": [] },
                { "type": "function_call", "call_id": "c1", "name": "read", "arguments": "{\"path\":\"a\"}" },
                { "type": "function_call", "call_id": "c2", "name": "ls", "arguments": "{}" },
                { "type": "function_call_output", "call_id": "c1", "output": "file a" },
            ],
            "tools": [{ "type": "function", "name": "read", "description": "d", "parameters": { "type": "object" } }, { "type": "web_search" }],
            "tool_choice": { "type": "function", "name": "read" },
        })).unwrap();
        let m = chat["messages"].as_array().unwrap();
        assert_eq!(m[0], json!({ "role": "system", "content": "rules" }));
        assert_eq!(m[1]["content"][1]["image_url"]["url"], "data:image/png;base64,AA==");
        assert_eq!(m[2]["tool_calls"].as_array().unwrap().len(), 2, "calls of one turn share a message");
        assert_eq!(m[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(m[3], json!({ "role": "tool", "tool_call_id": "c1", "content": "file a" }));
        assert_eq!(chat["tools"].as_array().unwrap().len(), 1, "hosted tools are not offered");
        assert_eq!(chat["tools"][0]["function"]["name"], "read");
        assert_eq!(chat["tool_choice"], json!({ "type": "function", "function": { "name": "read" } }));
    }

    #[test]
    fn what_cannot_be_done_is_refused_by_name() {
        for (req, needle) in [
            (json!({ "input": "x" }), "`model` is required"),
            (json!({ "model": "m", "input": "x", "previous_response_id": "resp_1" }), "previous_response_id"),
            (json!({ "model": "m", "input": [{ "type": "item_reference", "id": "x" }] }), "item_reference"),
            (json!({ "model": "m", "input": [{ "role": "user", "content": [{ "type": "input_file", "file_id": "f" }] }] }), "input_file"),
            (json!({ "model": "m", "input": [] }), "empty"),
            (json!({ "model": "m" }), "`input`"),
        ] {
            let Unsupported(why) = request_to_chat(&req).unwrap_err();
            assert!(why.contains(needle), "{why}");
        }
    }

    #[test]
    fn structured_output_and_streaming_options_carry_over() {
        let chat = request_to_chat(&json!({
            "model": "m", "input": "x", "stream": true, "reasoning": { "effort": "low" },
            "text": { "format": { "type": "json_schema", "name": "out", "schema": { "type": "object" }, "strict": true } },
        })).unwrap();
        assert_eq!(chat["stream_options"], json!({ "include_usage": true }));
        assert_eq!(chat["reasoning_effort"], "low");
        assert_eq!(chat["response_format"]["json_schema"]["name"], "out");
    }

    #[test]
    fn a_chat_answer_becomes_a_response_with_text_calls_and_usage() {
        let req = json!({ "model": "m", "input": "x", "instructions": "i" });
        let chat = json!({
            "model": "m", "created": 7,
            "choices": [{ "message": { "content": "Hello", "tool_calls": [{ "id": "c9", "type": "function", "function": { "name": "read", "arguments": "{}" } }] }, "finish_reason": "tool_calls" }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14, "prompt_tokens_details": { "cached_tokens": 3 } },
        });
        let r = chat_to_response(&req, &chat);
        assert_eq!((r["object"].as_str(), r["status"].as_str(), r["created_at"].as_u64()), (Some("response"), Some("completed"), Some(7)));
        assert!(r["id"].as_str().unwrap().starts_with("resp_"));
        assert_eq!(r["output"][0]["content"][0]["text"], "Hello");
        assert_eq!((r["output"][1]["type"].as_str(), r["output"][1]["call_id"].as_str()), (Some("function_call"), Some("c9")));
        assert_eq!((r["usage"]["input_tokens"].as_u64(), r["usage"]["output_tokens"].as_u64(), r["usage"]["total_tokens"].as_u64()), (Some(10), Some(4), Some(14)));
        assert_eq!(r["usage"]["input_tokens_details"]["cached_tokens"], 3);
        assert_eq!(r["instructions"], "i");
        let cut = chat_to_response(&req, &json!({ "choices": [{ "message": { "content": "x" }, "finish_reason": "length" }] }));
        assert_eq!((cut["status"].as_str(), cut["incomplete_details"]["reason"].as_str()), (Some("incomplete"), Some("max_output_tokens")));
    }

    #[test]
    fn reasoning_becomes_a_reasoning_item_and_a_filter_is_incomplete() {
        let req = json!({ "model": "m", "input": "x" });
        let r = chat_to_response(
            &req,
            &json!({ "choices": [{ "message": { "content": "A", "reasoning_content": "think" }, "finish_reason": "content_filter" }] }),
        );
        assert_eq!(r["output"][0]["type"], "reasoning");
        assert_eq!(r["output"][0]["summary"][0]["text"], "think");
        assert_eq!(r["output"][1]["content"][0]["text"], "A");
        assert_eq!((r["status"].as_str(), r["incomplete_details"]["reason"].as_str()), (Some("incomplete"), Some("content_filter")));

        let mut m = StreamMapper::new(&req);
        let mut all = Vec::new();
        for d in [
            r#"{"choices":[{"delta":{"reasoning_content":"th"}}]}"#,
            r#"{"choices":[{"delta":{"reasoning_content":"ink"}}]}"#,
            r#"{"choices":[{"delta":{"content":"A"},"finish_reason":"content_filter"}]}"#,
            "[DONE]",
        ] {
            all.extend(m.feed(d));
        }
        let ev = events(&all);
        let names: Vec<&str> = ev.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "response.created", "response.in_progress", "response.output_item.added",
                "response.reasoning_summary_part.added", "response.reasoning_summary_text.delta",
                "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
                "response.reasoning_summary_part.done", "response.output_item.done",
                "response.output_item.added", "response.content_part.added", "response.output_text.delta",
                "response.output_text.done", "response.content_part.done", "response.output_item.done",
                "response.incomplete",
            ]
        );
        let done = &ev.last().unwrap().1["response"];
        assert_eq!(done["output"][0]["summary"][0]["text"], "think");
        assert_eq!(done["output"][1]["content"][0]["text"], "A");
        assert_eq!(done["incomplete_details"]["reason"], "content_filter");
    }

    #[test]
    fn a_text_stream_emits_the_documented_event_sequence() {
        let mut m = StreamMapper::new(&json!({ "model": "m", "input": "x" }));
        let mut all = Vec::new();
        for d in [
            r#"{"model":"m","choices":[{"delta":{"role":"assistant","content":"He"}}]}"#,
            r#"{"choices":[{"delta":{"content":"llo"}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}"#,
            "[DONE]",
        ] {
            all.extend(m.feed(d));
        }
        let ev = events(&all);
        let names: Vec<&str> = ev.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
                "response.output_text.delta", "response.output_text.delta", "response.output_text.done",
                "response.content_part.done", "response.output_item.done", "response.completed",
            ]
        );
        let seqs: Vec<u64> = ev.iter().map(|(_, d)| d["sequence_number"].as_u64().unwrap()).collect();
        assert_eq!(seqs, (0..10).collect::<Vec<u64>>(), "sequence numbers count up from 0");
        assert_eq!(ev[6].1["text"], "Hello");
        let done = &ev[9].1["response"];
        assert_eq!((done["status"].as_str(), done["output"][0]["content"][0]["text"].as_str()), (Some("completed"), Some("Hello")));
        assert_eq!(done["usage"]["input_tokens"], 5, "usage arriving after the finish reason is kept");
        assert!(m.feed("[DONE]").is_empty() && m.finish().is_empty(), "completes once");
    }

    #[test]
    fn tool_call_deltas_become_function_call_items() {
        let mut m = StreamMapper::new(&json!({ "model": "m" }));
        let mut all = Vec::new();
        for d in [
            r#"{"choices":[{"delta":{"content":"ok"}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\"pa"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":1}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            "[DONE]",
        ] {
            all.extend(m.feed(d));
        }
        let ev = events(&all);
        let names: Vec<&str> = ev.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"response.function_call_arguments.delta") && names.contains(&"response.function_call_arguments.done"), "{names:?}");
        let done = &ev.last().unwrap().1["response"];
        assert_eq!(done["output"][0]["type"], "message");
        assert_eq!((done["output"][1]["name"].as_str(), done["output"][1]["arguments"].as_str(), done["output"][1]["call_id"].as_str()), (Some("read"), Some("{\"path\":1}"), Some("c1")));
        assert_eq!(done["output"][1]["status"], "completed");
    }

    #[test]
    fn a_length_stop_is_incomplete_and_a_stream_error_is_a_failure() {
        let mut m = StreamMapper::new(&json!({ "model": "m" }));
        m.feed(r#"{"choices":[{"delta":{"content":"a"},"finish_reason":"length"}]}"#);
        let end = events(&m.feed("[DONE]"));
        assert_eq!(end.last().unwrap().0, "response.incomplete");
        let mut f = StreamMapper::new(&json!({ "model": "m" }));
        let fail = events(&f.feed(r#"{"error":{"message":"boom","code":"x"}}"#));
        assert_eq!(fail.last().unwrap().0, "response.failed");
        assert_eq!(fail.last().unwrap().1["response"]["error"]["message"], "boom");
        assert!(f.feed("[DONE]").is_empty());
    }

    #[tokio::test]
    async fn a_stream_that_dies_midway_fails_instead_of_completing() {
        let chunks: Vec<Result<Bytes, String>> = vec![
            Ok(Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"content\":\"par\"}}]}

")),
            Err("connection reset".to_string()),
        ];
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        pump(json!({ "model": "m" }), futures_util::stream::iter(chunks), tx).await;
        let mut raw = Vec::new();
        while let Some(Ok(f)) = rx.recv().await {
            raw.push(String::from_utf8(f.into_data().unwrap().to_vec()).unwrap());
        }
        let ev = events(&raw);
        let names: Vec<&str> = ev.iter().map(|(n, _)| n.as_str()).collect();
        assert!(!names.contains(&"response.completed"), "{names:?}");
        assert_eq!(names[names.len() - 2], "error");
        assert_eq!(ev.last().unwrap().0, "response.failed");
        assert!(ev.last().unwrap().1["response"]["error"]["message"].as_str().unwrap().contains("connection reset"));
    }

    #[test]
    fn sse_events_are_found_across_both_line_endings() {
        assert_eq!(event_end(b"data: 1\n\ndata: 2"), Some((7, 2)));
        assert_eq!(event_end(b"data: 1\r\n\r\nrest"), Some((7, 4)));
        assert_eq!(event_end(b"data: 1\n"), None);
    }

    /// A stand-in chat route: records what it was sent and answers with `reply`.
    fn stub_chat(content_type: &'static str, reply: String) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            let Ok((mut s, _)) = listener.accept() else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = s.read(&mut chunk).unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let want = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if body.len() >= want || n == 0 {
                        log.lock().unwrap().push(head.to_ascii_lowercase());
                        log.lock().unwrap().push(body.to_string());
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
        });
        (url, seen)
    }

    async fn collect(h: Handled) -> (StatusCode, String) {
        let body = h.body.collect().await.unwrap().to_bytes();
        (h.status, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn a_whole_answer_goes_through_the_chat_route_with_the_callers_key() {
        let reply = json!({ "model": "m", "choices": [{ "message": { "content": "pong" }, "finish_reason": "stop" }], "usage": { "prompt_tokens": 3, "completion_tokens": 1 } }).to_string();
        let (url, seen) = stub_chat("application/json", reply);
        let mut headers = hyper::HeaderMap::new();
        headers.insert("authorization", "Bearer k-123".parse().unwrap());
        let body = json!({ "model": "m", "input": "ping", "instructions": "be brief" }).to_string();
        let (status, text) = collect(handle(body.as_bytes(), &headers, &url, &reqwest::Client::new()).await).await;
        assert_eq!(status, StatusCode::OK);
        let r: Value = serde_json::from_str(&text).unwrap();
        assert_eq!((r["object"].as_str(), r["output"][0]["content"][0]["text"].as_str(), r["usage"]["input_tokens"].as_u64()), (Some("response"), Some("pong"), Some(3)));
        let seen = seen.lock().unwrap();
        assert!(seen[0].contains("authorization: bearer k-123"), "the key is passed on: {}", seen[0]);
        let sent: Value = serde_json::from_str(&seen[1]).unwrap();
        assert_eq!(sent["messages"][1], json!({ "role": "user", "content": "ping" }));
        assert_eq!(sent["stream"], false);
    }

    #[tokio::test]
    async fn a_streamed_answer_is_rewritten_into_response_events() {
        let sse = [
            r#"data: {"model":"m","choices":[{"delta":{"content":"po"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"ng"},"finish_reason":"stop"}]}"#,
            r#"data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}"#,
            "data: [DONE]",
        ]
        .join("\n\n")
            + "\n\n";
        let (url, seen) = stub_chat("text/event-stream", sse);
        let body = json!({ "model": "m", "input": "ping", "stream": true }).to_string();
        let handled = handle(body.as_bytes(), &hyper::HeaderMap::new(), &url, &reqwest::Client::new()).await;
        assert_eq!(handled.content_type, "text/event-stream");
        let (status, text) = collect(handled).await;
        assert_eq!(status, StatusCode::OK);
        let names: Vec<&str> = text.lines().filter_map(|l| l.strip_prefix("event: ")).collect();
        assert_eq!(names.first(), Some(&"response.created"));
        assert_eq!(names.last(), Some(&"response.completed"));
        assert_eq!(names.iter().filter(|n| **n == "response.output_text.delta").count(), 2);
        assert!(text.contains(r#""text":"pong""#), "{text}");
        let sent: Value = serde_json::from_str(&seen.lock().unwrap()[1]).unwrap();
        assert_eq!((sent["stream"].as_bool(), sent["stream_options"]["include_usage"].as_bool()), (Some(true), Some(true)));
    }

    #[tokio::test]
    async fn errors_are_passed_back_and_bad_requests_never_reach_the_chat_route() {
        let (url, _seen) = stub_chat("application/json", "{}".to_string());
        let (status, text) = collect(handle(br#"{"input":"x"}"#, &hyper::HeaderMap::new(), &url, &reqwest::Client::new()).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let err: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(err["error"]["code"], "missing_required_parameter", "{text}");
        assert_eq!(err["error"]["param"], "model", "{text}");
        assert_eq!(err["error"]["type"], "invalid_request_error", "{text}");
        assert_eq!(err["error"]["message"], "`model` is required", "{text}");
        let (status, text) = collect(handle(b"not json", &hyper::HeaderMap::new(), &url, &reqwest::Client::new()).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(text.contains("invalid_json"), "{text}");
        // Nothing listens here: a gateway error, not a hang or a panic.
        let (status, _) = collect(handle(br#"{"model":"m","input":"x"}"#, &hyper::HeaderMap::new(), "http://127.0.0.1:9/v1/chat/completions", &reqwest::Client::new()).await).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn the_inner_call_goes_to_this_server_on_loopback() {
        assert_eq!(loopback_url("0.0.0.0", 1337, "/v1"), "http://127.0.0.1:1337/v1/chat/completions");
        assert_eq!(loopback_url("127.0.0.1", 8080, "/v1"), "http://127.0.0.1:8080/v1/chat/completions");
        assert_eq!(loopback_url("::1", 8080, ""), "http://[::1]:8080/chat/completions");
    }
}
