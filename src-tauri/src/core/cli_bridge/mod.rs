//! A loopback OpenAI-compatible endpoint backed by the official Claude Code,
//! Codex and Gemini CLIs.
//!
//! Flint's providers are OpenAI-shaped HTTP upstreams, so chats, rooms,
//! campaigns, translate and every other feature reach a subscription model by
//! pointing a provider at this bridge. The bridge shells out to the vendor's own
//! signed-in CLI; Flint never sees or stores the vendor's login.
//!
//! Using a subscription this way is still bound by the vendor's terms. Anthropic
//! limits subscription plans to ordinary individual use, so unattended
//! multi-agent runs belong on an API key: see [`DISCLAIMER`].

pub mod backend;
#[cfg(not(feature = "cli"))]
pub mod commands;
#[cfg(feature = "cli")]
pub mod connect;
pub mod prompt;

use std::convert::Infallible;
use std::sync::OnceLock;

use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore};

use backend::{Backend, Event};
use prompt::{build_prompt, ToolStream};

/// Default loopback port. Both the desktop app and the CLI use it, so whichever
/// process starts first serves the other.
pub const DEFAULT_PORT: u16 = 17642;

/// Shown next to every bridge provider.
pub const DISCLAIMER: &str = "Uses your own signed-in vendor CLI and your subscription. Vendor terms still apply: Anthropic and Google limit subscription plans to ordinary individual use, so do not share this login or run large unattended jobs on it. Use an API key for those. Flint is not affiliated with Anthropic, OpenAI or Google.";

/// Requests running at once. A subscription is not built for fan-out, and every
/// request is a CLI process.
const MAX_CONCURRENT: usize = 2;

static GATE: OnceLock<Semaphore> = OnceLock::new();
static STARTED: tokio::sync::OnceCell<u16> = tokio::sync::OnceCell::const_new();

type Body = BoxBody<Bytes, Infallible>;

/// Base URL a provider should use for `backend`.
pub fn base_url(backend: Backend) -> String {
    format!("http://127.0.0.1:{DEFAULT_PORT}/{}/v1", backend.id())
}

/// Whether `url` points at this bridge (any backend).
pub fn is_bridge_url(url: &str) -> bool {
    let prefix = format!("http://127.0.0.1:{DEFAULT_PORT}/");
    url.trim()
        .strip_prefix(&prefix)
        .is_some_and(|rest| Backend::ALL.iter().any(|backend| rest.starts_with(backend.id())))
}

/// Whether `model` (optionally `provider/model`) is served by a bridge backend.
pub fn is_bridge_model(model: &str) -> bool {
    if let Some((provider, _)) = model.split_once('/') {
        if Backend::from_id(provider).is_some() {
            return true;
        }
    }
    let name = model.rsplit('/').next().unwrap_or(model);
    Backend::ALL.iter().any(|backend| backend.models().iter().any(|m| m == name))
}

fn token_path() -> std::path::PathBuf {
    crate::core::app::commands::resolve_jan_data_folder().join("cli-bridge-token")
}

/// The shared secret the bridge expects as a Bearer key. Created on first use
/// and stored beside Flint's other data so every Flint process agrees on it.
pub fn token() -> Result<String, String> {
    let path = token_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if existing.len() >= 32 {
            return Ok(existing);
        }
    }
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, &token).map_err(|error| format!("could not store the bridge token: {error}"))?;
    Ok(token)
}

/// Start the bridge once per process. If another Flint process already owns
/// the port, that one serves this process too.
pub async fn ensure_started() -> Result<u16, String> {
    STARTED
        .get_or_try_init(|| async {
            let token = token()?;
            match tokio::net::TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).await {
                Ok(listener) => {
                    tokio::spawn(serve(listener, token));
                    Ok(DEFAULT_PORT)
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Ok(DEFAULT_PORT),
                Err(error) => Err(format!("could not start the CLI bridge: {error}")),
            }
        })
        .await
        .copied()
}

async fn serve(listener: tokio::net::TcpListener, token: String) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let token = token.clone();
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let token = token.clone();
                async move { Ok::<_, Infallible>(handle(request, &token).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await;
        });
    }
}

fn reply(status: StatusCode, body: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())).boxed())
        .expect("static response")
}

fn error(status: StatusCode, message: &str) -> Response<Body> {
    reply(status, json!({"error": {"message": message, "type": "cli_bridge_error"}}))
}

/// Refuse anything that is not a local, deliberate caller: a browser page
/// (Origin), a rebound hostname (Host), or a request without the shared token.
fn authorized(request: &Request<Incoming>, token: &str) -> Result<(), Response<Body>> {
    // Only the app's own webview may send an Origin; a web page may not.
    if let Some(origin) = request.headers().get("origin") {
        let own = matches!(
            origin.to_str(),
            Ok("tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost")
        );
        if !own {
            return Err(error(StatusCode::FORBIDDEN, "browser requests are not allowed"));
        }
    }
    let host_ok = request
        .headers()
        .get("host")
        .and_then(|host| host.to_str().ok())
        .is_some_and(|host| {
            let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
            matches!(name, "127.0.0.1" | "localhost" | "[::1]")
        });
    if !host_ok {
        return Err(error(StatusCode::FORBIDDEN, "unexpected host"));
    }
    let presented = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(presented.as_bytes(), token.as_bytes()) {
        return Err(error(StatusCode::UNAUTHORIZED, "missing or wrong bridge key"));
    }
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

async fn handle(request: Request<Incoming>, token: &str) -> Response<Body> {
    if let Err(response) = authorized(&request, token) {
        return response;
    }
    let path = request.uri().path().to_string();
    let mut segments = path.trim_matches('/').split('/');
    let backend = segments.next().and_then(Backend::from_id);
    let rest: Vec<&str> = segments.collect();
    let Some(backend) = backend else {
        return error(StatusCode::NOT_FOUND, "unknown backend");
    };
    match (request.method(), rest.as_slice()) {
        (&Method::GET, ["v1", "models"]) => {
            let data: Vec<Value> = backend
                .discover_models()
                .await
                .into_iter()
                .map(|id| json!({"id": id, "object": "model", "owned_by": backend.id()}))
                .collect();
            reply(StatusCode::OK, json!({"object": "list", "data": data}))
        }
        (&Method::POST, ["v1", "chat", "completions"]) => {
            let bytes = match request.into_body().collect().await {
                Ok(collected) => collected.to_bytes(),
                Err(_) => return error(StatusCode::BAD_REQUEST, "could not read the request"),
            };
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(body) => completion(backend, body).await,
                Err(_) => error(StatusCode::BAD_REQUEST, "the request body was not JSON"),
            }
        }
        _ => error(StatusCode::NOT_FOUND, "unknown route"),
    }
}

fn chunk(id: &str, model: &str, delta: Value, finish: Value) -> String {
    let payload = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": unix_now(),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    });
    format!("data: {payload}\n\n")
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

fn tool_call_json(index: usize, call: &prompt::ToolCall, request_id: &str) -> Value {
    json!({
        "index": index,
        "id": format!("call_{request_id}_{index}"),
        "type": "function",
        "function": {"name": call.name, "arguments": call.arguments.to_string()},
    })
}

async fn completion(backend: Backend, body: Value) -> Response<Body> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .map(|model| model.rsplit('/').next().unwrap_or(model).to_string())
        .unwrap_or_else(|| backend.models().remove(0));
    let streaming = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let want_usage = body["stream_options"]["include_usage"].as_bool().unwrap_or(false);
    // Validated against each CLI's own levels in `Backend::args`.
    let effort = body.get("reasoning_effort").and_then(Value::as_str).map(str::to_string);
    let prompt = build_prompt(&body);
    let stdin_text = if prompt.system.is_empty() {
        format!("{}{}", backend.preamble(), prompt.transcript)
    } else {
        format!("{}[system]\n{}\n\n{}", backend.preamble(), prompt.system, prompt.transcript)
    };
    let id = format!("{:x}", rand::random::<u64>());
    let reply_model = model.clone();
    let start = move |stdin_text: String| {
        let (events_tx, events_rx) = mpsc::channel::<Event>(64);
        let run_model = model.clone();
        let run_effort = effort.clone();
        let images = prompt.images.clone();
        tokio::spawn(async move {
            let gate = GATE.get_or_init(|| Semaphore::new(MAX_CONCURRENT));
            let _permit = gate.acquire().await;
            backend::run(backend, &run_model, run_effort.as_deref(), stdin_text, images, events_tx).await;
        });
        events_rx
    };
    let mut events_rx = start(stdin_text.clone());

    let (out_tx, out_rx) = mpsc::channel::<String>(64);
    let has_tools = prompt.has_tools;
    // Pump CLI events into OpenAI-shaped output.
    let pump = tokio::spawn(async move {
        let mut filter = ToolStream::default();
        let mut collected = String::new();
        let mut failure: Option<String> = None;
        let mut usage = (0u64, 0u64);
        let mut retried = false;
        // The role chunk goes out with the first real output, so a CLI that
        // fails before answering still gets a proper HTTP status (see below).
        let mut opened = false;
        loop {
            while let Some(event) = events_rx.recv().await {
                match event {
                    Event::Text(text) => {
                        let ready = if has_tools { filter.push(&text) } else { text };
                        if ready.is_empty() {
                            continue;
                        }
                        collected.push_str(&ready);
                        if streaming {
                            if !opened {
                                opened = true;
                                let role = chunk(&id, &reply_model, json!({"role": "assistant", "content": ""}), Value::Null);
                                if out_tx.send(role).await.is_err() {
                                    return;
                                }
                            }
                            if out_tx.send(chunk(&id, &reply_model, json!({"content": ready}), Value::Null)).await.is_err() {
                                return;
                            }
                        }
                    }
                    // A finished turn outranks an earlier error the CLI recovered
                    // from (Codex reports retried stream drops as `error`).
                    Event::Usage { input, output } => {
                        usage = (input, output);
                        failure = None;
                    }
                    Event::Failed(message) => failure = Some(message),
                }
            }
            // A model that wrote its own tool syntax gets one corrected retry,
            // provided nothing has reached the caller yet.
            if has_tools && !retried && failure.is_none() && filter.unusable_foreign_reply() && collected.trim().is_empty() {
                retried = true;
                filter = ToolStream::default();
                let fixed = match stdin_text.strip_suffix("[assistant]
") {
                    Some(head) => format!(
                        "{head}[reminder]
Your previous reply used an unsupported tool syntax and was discarded. Call a tool only by writing <tool_call>{{\"name\":...,\"arguments\":{{...}}}}</tool_call>.

[assistant]
"
                    ),
                    None => stdin_text.clone(),
                };
                events_rx = start(fixed);
                continue;
            }
            break;
        }
        let (tail, calls) = if has_tools { filter.finish() } else { (String::new(), Vec::new()) };
        collected.push_str(&tail);
        if let Some(message) = failure {
            let error = json!({"error": {"message": message, "type": "cli_bridge_error"}});
            let _ = out_tx
                .send(if streaming && opened { format!("data: {error}\n\n") } else { error.to_string() })
                .await;
            return;
        }
        let tool_calls: Vec<Value> = calls.iter().enumerate().map(|(i, call)| tool_call_json(i, call, &id)).collect();
        let finish = if tool_calls.is_empty() { "stop" } else { "tool_calls" };
        if streaming {
            if !opened {
                let _ = out_tx
                    .send(chunk(&id, &reply_model, json!({"role": "assistant", "content": ""}), Value::Null))
                    .await;
            }
            if !tail.is_empty() {
                let _ = out_tx.send(chunk(&id, &reply_model, json!({"content": tail}), Value::Null)).await;
            }
            if !tool_calls.is_empty() {
                let _ = out_tx.send(chunk(&id, &reply_model, json!({"tool_calls": tool_calls}), Value::Null)).await;
            }
            let _ = out_tx.send(chunk(&id, &reply_model, json!({}), json!(finish))).await;
            if want_usage {
                let payload = json!({
                    "id": id, "object": "chat.completion.chunk", "created": unix_now(), "model": reply_model,
                    "choices": [],
                    "usage": {"prompt_tokens": usage.0, "completion_tokens": usage.1, "total_tokens": usage.0 + usage.1},
                });
                let _ = out_tx.send(format!("data: {payload}\n\n")).await;
            }
            let _ = out_tx.send("data: [DONE]\n\n".to_string()).await;
        } else {
            let mut message = json!({"role": "assistant", "content": collected});
            if !tool_calls.is_empty() {
                message["tool_calls"] = json!(tool_calls
                    .iter()
                    .map(|call| {
                        let mut call = call.clone();
                        call.as_object_mut().map(|object| object.remove("index"));
                        call
                    })
                    .collect::<Vec<_>>());
            }
            let payload = json!({
                "id": id, "object": "chat.completion", "created": unix_now(), "model": reply_model,
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {"prompt_tokens": usage.0, "completion_tokens": usage.1, "total_tokens": usage.0 + usage.1},
            });
            let _ = out_tx.send(payload.to_string()).await;
        }
    });

    let mut out_rx = out_rx;
    if streaming {
        // Hold the headers until the CLI says something: a failure before any
        // output becomes a real status the caller can classify, instead of a
        // 200 stream every client retries as a dropped connection.
        let Some(first) = out_rx.recv().await else {
            return error(StatusCode::BAD_GATEWAY, "the CLI returned no answer");
        };
        if !first.starts_with("data: ") {
            let _ = pump.await;
            return match serde_json::from_str::<Value>(&first) {
                Ok(value) => failure_reply(value),
                Err(_) => error(StatusCode::BAD_GATEWAY, "the CLI returned no answer"),
            };
        }
        let rest = tokio_stream::wrappers::ReceiverStream::new(out_rx);
        let stream = futures::stream::once(async move { first })
            .chain(rest)
            .map(|text| Ok::<_, Infallible>(Frame::data(Bytes::from(text))));
        let body = BodyExt::boxed(StreamBody::new(stream));
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(body)
            .expect("static response");
    }
    // Non-streaming: wait for the single JSON payload (or an error object).
    let payload = out_rx.recv().await.unwrap_or_default();
    let _ = pump.await;
    match serde_json::from_str::<Value>(&payload) {
        Ok(value) if value.get("error").is_some() => failure_reply(value),
        Ok(value) => reply(StatusCode::OK, value),
        Err(_) => error(StatusCode::BAD_GATEWAY, "the CLI returned no answer"),
    }
}

/// The HTTP status for a CLI failure, plus a `Retry-After` in seconds when the
/// message says how long to wait. Callers retry 429/5xx and give up on other
/// 4xx, so only failures another attempt might fix get a retryable status.
/// Matching is on the CLIs' own wording; anything unrecognised stays 502.
fn failure_status(message: &str) -> (StatusCode, Option<u64>) {
    let lower = message.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    // Checked first: the install hint itself mentions `login`.
    if has(&["not installed or not on path", "could not start"]) {
        return (StatusCode::FAILED_DEPENDENCY, None);
    }
    // Claude Code: "Claude AI usage limit reached|<reset unix seconds>".
    if has(&["usage limit", "limit reached", "out of extra usage", "quota"]) {
        let reset = message
            .rsplit_once('|')
            .and_then(|(_, tail)| tail.trim().parse::<u64>().ok())
            .map(|reset| reset.saturating_sub(unix_now()).max(1));
        // 402, not 429: the plan's window resets in hours, so retrying within a
        // request's budget only burns attempts. Clients treat 402 as "out of
        // credit on this login" and stop.
        return (StatusCode::PAYMENT_REQUIRED, Some(reset.unwrap_or(3600)));
    }
    if has(&["rate limit", "rate_limit", "too many requests", "429"]) {
        return (StatusCode::TOO_MANY_REQUESTS, None);
    }
    if has(&["not logged in", "please run /login", "login", "log in", "sign in", "authenticat", "unauthorized", "401", "oauth token", "invalid api key"]) {
        return (StatusCode::UNAUTHORIZED, None);
    }
    if has(&["issue with the selected model", "model not found", "unknown model", "does not exist", "not supported", "unrecognized_model"]) {
        return (StatusCode::BAD_REQUEST, None);
    }
    (StatusCode::BAD_GATEWAY, None)
}

fn failure_reply(value: Value) -> Response<Body> {
    let message = value["error"]["message"].as_str().unwrap_or_default();
    let (status, retry_after) = failure_status(message);
    let mut response = reply(status, value);
    if let Some(seconds) = retry_after {
        if let Ok(header) = hyper::header::HeaderValue::from_str(&seconds.to_string()) {
            response.headers_mut().insert("retry-after", header);
        }
    }
    response
}

use futures::StreamExt;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_loopback_and_names_the_backend() {
        assert_eq!(base_url(Backend::Claude), format!("http://127.0.0.1:{DEFAULT_PORT}/claude-cli/v1"));
    }

    #[test]
    fn token_comparison_is_exact() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    async fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut request = format!("{method} {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\ncontent-length: {}\r\n", body.len());
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        request.push_str(body);
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        let status = raw.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        (status, raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
    }

    async fn test_server() -> u16 {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(listener, "secret-token-secret-token-secret-token".into()));
        port
    }

    #[tokio::test]
    async fn the_bridge_refuses_missing_keys_browsers_and_unknown_backends() {
        let port = test_server().await;
        let key = ("authorization", "Bearer secret-token-secret-token-secret-token");
        assert_eq!(http(port, "GET", "/claude-cli/v1/models", &[], "").await.0, 401);
        assert_eq!(http(port, "GET", "/claude-cli/v1/models", &[("authorization", "Bearer nope")], "").await.0, 401);
        assert_eq!(http(port, "GET", "/claude-cli/v1/models", &[key, ("origin", "https://evil.example")], "").await.0, 403);
        assert_eq!(http(port, "GET", "/nothing/v1/models", &[key], "").await.0, 404);
        let (status, body) = http(port, "GET", "/claude-cli/v1/models", &[key], "").await;
        assert_eq!(status, 200);
        assert!(body.contains("\"id\":\"claude-opus-5-5\""), "{body}");
    }

    async fn live_roundtrip(backend: Backend, model: &str) {
        let port = test_server().await;
        let key = ("authorization", "Bearer secret-token-secret-token-secret-token");
        let path = format!("/{}/v1/chat/completions", backend.id());
        let plain = json!({"model": model, "messages": [{"role": "user", "content": "Reply with exactly: pong"}]});
        let (status, body) = http(port, "POST", &path, &[key], &plain.to_string()).await;
        assert_eq!(status, 200, "{body}");
        let value: Value = serde_json::from_str(&body).unwrap();
        assert!(value["choices"][0]["message"]["content"].as_str().unwrap().to_lowercase().contains("pong"), "{body}");

        let tools = json!({
            "model": model,
            "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
            "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}]
        });
        let (status, body) = http(port, "POST", &path, &[key], &tools.to_string()).await;
        assert_eq!(status, 200, "{body}");
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["choices"][0]["finish_reason"], "tool_calls", "{body}");
        assert_eq!(value["choices"][0]["message"]["tool_calls"][0]["function"]["name"], "get_weather", "{body}");

        let streamed = json!({"model": model, "stream": true, "messages": [{"role": "user", "content": "Count: 1 2 3"}]});
        let (status, body) = http(port, "POST", &path, &[key], &streamed.to_string()).await;
        assert_eq!(status, 200);
        assert!(body.contains("data: [DONE]") && body.contains("\"content\":\""), "{body}");
    }

    /// Live tests need the vendor CLI installed and signed in:
    /// `cargo test cli_bridge::tests::live_ -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_claude() {
        live_roundtrip(Backend::Claude, "claude-haiku-5-5").await;
    }

    /// A CLI failure before any output is a real status, streamed or not.
    #[tokio::test]
    #[ignore]
    async fn live_claude_bad_model() {
        let port = test_server().await;
        let key = ("authorization", "Bearer secret-token-secret-token-secret-token");
        for stream in [false, true] {
            let body = json!({"model": "claude-nonexistent-9", "stream": stream, "messages": [{"role": "user", "content": "hi"}]});
            let (status, text) = http(port, "POST", "/claude-cli/v1/chat/completions", &[key], &body.to_string()).await;
            assert_eq!(status, 400, "stream={stream} {text}");
            assert!(text.contains("selected model"), "{text}");
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_codex() {
        let model = Backend::Codex.discover_models().await.remove(0);
        live_roundtrip(Backend::Codex, &model).await;
    }

    /// A solid red 32x32 PNG; the model must name the colour.
    const RED_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";

    async fn live_image(backend: Backend, model: &str) {
        let port = test_server().await;
        let key = ("authorization", "Bearer secret-token-secret-token-secret-token");
        let path = format!("/{}/v1/chat/completions", backend.id());
        let body = json!({"model": model, "messages": [{"role": "user", "content": [
            {"type": "text", "text": "What single colour fills this image? Answer with one word."},
            {"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{RED_PNG}")}}
        ]}]});
        let (status, body) = http(port, "POST", &path, &[key], &body.to_string()).await;
        assert_eq!(status, 200, "{body}");
        let value: Value = serde_json::from_str(&body).unwrap();
        let text = value["choices"][0]["message"]["content"].as_str().unwrap().to_lowercase();
        assert!(text.contains("red"), "{body}");
    }

    #[tokio::test]
    #[ignore]
    async fn live_claude_image() {
        live_image(Backend::Claude, "claude-haiku-5-5").await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_codex_image() {
        let model = Backend::Codex.discover_models().await.remove(0);
        live_image(Backend::Codex, &model).await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_gemini_image() {
        live_image(Backend::Gemini, "gemini-2.5-flash").await;
    }

    /// Every advertised model, one at a time; prints a verdict per model.
    async fn live_all(backend: Backend) {
        let mut failed = Vec::new();
        // FLINT_LIVE_MODELS="a,b" limits the run to those models.
        let only = std::env::var("FLINT_LIVE_MODELS").unwrap_or_default();
        for model in backend.discover_models().await {
            if !only.is_empty() && !only.split(',').any(|name| name == model) {
                continue;
            }
            let m = model.clone();
            let ok = tokio::spawn(async move {
                live_roundtrip(backend, &m).await;
                live_image(backend, &m).await;
            })
            .await
            .is_ok();
            println!("LIVE {} {model}: {}", backend.id(), if ok { "ok" } else { "FAILED" });
            if !ok {
                failed.push(model);
            }
        }
        assert!(failed.is_empty(), "failed: {failed:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn live_claude_all() {
        live_all(Backend::Claude).await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_codex_all() {
        live_all(Backend::Codex).await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_gemini() {
        live_roundtrip(Backend::Gemini, "gemini-2.5-flash").await;
    }

    #[test]
    fn cli_failures_map_to_statuses_callers_can_classify() {
        // Recorded from Claude Code 2.1.303 with an unknown --model.
        let bad_model = "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.";
        assert_eq!(failure_status(bad_model), (StatusCode::BAD_REQUEST, None));
        let reset = unix_now() + 120;
        let (status, retry) = failure_status(&format!("Claude AI usage limit reached|{reset}"));
        assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
        assert!(retry.is_some_and(|s| (100..=121).contains(&s)), "{retry:?}");
        assert_eq!(failure_status("You've hit your usage limit.").1, Some(3600));
        assert_eq!(failure_status("API Error: 429 rate_limit_error").0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(failure_status("Invalid API key · Please run /login").0, StatusCode::UNAUTHORIZED);
        assert_eq!(
            failure_status("claude is not installed or not on PATH. Install it and sign in with `claude login`.").0,
            StatusCode::FAILED_DEPENDENCY
        );
        assert_eq!(failure_status("API Error: 529 Overloaded").0, StatusCode::BAD_GATEWAY);
        assert_eq!(failure_status("claude stopped responding").0, StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn failure_reply_carries_retry_after() {
        let response = failure_reply(json!({"error": {"message": "usage limit reached", "type": "cli_bridge_error"}}));
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(response.headers()["retry-after"], "3600");
    }

    #[test]
    fn tool_calls_get_stable_ids() {
        let call = prompt::ToolCall { name: "bash".into(), arguments: json!({"cmd": "ls"}) };
        let value = tool_call_json(1, &call, "ab12");
        assert_eq!(value["id"], "call_ab12_1");
        assert_eq!(value["function"]["arguments"], "{\"cmd\":\"ls\"}");
    }
}
