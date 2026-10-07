//! Loopback listener for Flint's production browser bundle.
//!
//! Bind only to loopback. A private-network TLS proxy such as Tailscale Serve
//! can publish it; the proxy's exact public host must be configured here.

use std::collections::{HashSet, VecDeque};
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use super::auth::AuthStore;
use super::data;
use super::engine;
use super::files;
use super::mcp;
use super::provider;
use super::resources;
use super::uploads;
use super::static_files::{self, StaticError};

pub(super) type Resp = Response<UnsyncBoxBody<Bytes, std::convert::Infallible>>;
const MAX_LOGIN_BODY: usize = 4 * 1024;
const MAX_JSON_BODY: usize = 1024 * 1024;
const COOKIE_NAME: &str = "flint_session";
const LOGIN_WINDOW: Duration = Duration::from_secs(5 * 60);
const LOGIN_FAILURE_LIMIT: usize = 10;

pub struct Options {
    pub bind: SocketAddr,
    pub assets: PathBuf,
    pub data_folder: PathBuf,
    pub auth_file: PathBuf,
    /// Exact DNS name exposed by a private-network HTTPS proxy.
    pub public_host: Option<String>,
    /// Allow browser sessions to add and start stdio MCP servers (runs programs
    /// on this machine).
    pub allow_mcp_stdio: bool,
    /// Extra exact `host[:port]` values accepted in the Host header; required
    /// when binding beyond loopback.
    pub allowed_hosts: Vec<String>,
    /// Exact origins (`https://host[:port]`) that may call the API from another
    /// origin with a bearer token. Never a wildcard.
    pub allowed_origins: Vec<String>,
    /// The `flint-llama-worker` binary to supervise for local inference.
    pub llama_worker: Option<PathBuf>,
}

struct State {
    auth: Mutex<AuthStore>,
    assets: PathBuf,
    data_folder: PathBuf,
    hosts: HashSet<String>,
    public_host: Option<String>,
    login_failures: Mutex<VecDeque<Instant>>,
    mcp: mcp::Host,
    allowed_origins: HashSet<String>,
    engine: engine::Supervisor,
}

fn login_blocked(failures: &mut VecDeque<Instant>) -> bool {
    while failures
        .front()
        .is_some_and(|at| at.elapsed() > LOGIN_WINDOW)
    {
        failures.pop_front();
    }
    failures.len() >= LOGIN_FAILURE_LIMIT
}

fn valid_dns_name(host: &str) -> bool {
    host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

pub(super) fn reply(status: StatusCode, content_type: &'static str, body: impl Into<Bytes>) -> Resp {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header("x-frame-options", "DENY")
        .header("referrer-policy", "no-referrer")
        .header(
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        )
        .body(Full::new(body.into()).boxed_unsync())
        .expect("static response parts are valid")
}

pub(super) fn text(status: StatusCode, body: &'static str) -> Resp {
    reply(status, "text/plain; charset=utf-8", body)
}

fn json(value: &impl serde::Serialize) -> Resp {
    match serde_json::to_vec(value) {
        Ok(body) => reply(StatusCode::OK, "application/json", body),
        Err(_) => text(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not serialize response",
        ),
    }
}

fn json_created(value: &impl serde::Serialize) -> Resp {
    let mut response = json(value);
    if response.status() == StatusCode::OK {
        *response.status_mut() = StatusCode::CREATED;
    }
    response
}

async fn read_json(req: Request<Incoming>) -> Result<serde_json::Value, Resp> {
    let value = read_json_value(req).await?;
    if !value.is_object() {
        return Err(text(StatusCode::BAD_REQUEST, "Expected JSON object"));
    }
    Ok(value)
}

pub(super) async fn read_json_value(req: Request<Incoming>) -> Result<serde_json::Value, Resp> {
    let is_json = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json")));
    if !is_json {
        return Err(text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Expected application/json"));
    }
    let body = Limited::new(req.into_body(), MAX_JSON_BODY).collect().await
        .map_err(|_| text(StatusCode::PAYLOAD_TOO_LARGE, "Request too large"))?.to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| text(StatusCode::BAD_REQUEST, "Invalid JSON"))?;
    Ok(value)
}

fn session_cookie(headers: &hyper::HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (name == COOKIE_NAME
                && value.len() == 64
                && value.bytes().all(|c| c.is_ascii_hexdigit()))
            .then_some(value)
        })
}

fn host_allowed(state: &State, headers: &hyper::HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| state.hosts.contains(&h.to_ascii_lowercase()))
}

fn same_origin(state: &State, headers: &hyper::HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    if let Some(host) = origin.strip_prefix("https://") {
        return state.hosts.contains(&host.to_ascii_lowercase());
    }
    if let Some(host) = origin.strip_prefix("http://") {
        return state.hosts.contains(&host.to_ascii_lowercase())
            && state.public_host.as_deref() != Some(host);
    }
    false
}

/// `host` or `host:port`, where host is a DNS name, an IPv4 literal or a
/// bracketed IPv6 literal. No scheme, path or wildcard.
fn valid_host_entry(entry: &str) -> bool {
    if entry.is_empty() || entry.len() > 260 {
        return false;
    }
    let (host, port) = if let Some(rest) = entry.strip_prefix('[') {
        let Some((inner, after)) = rest.split_once(']') else {
            return false;
        };
        if inner.parse::<std::net::Ipv6Addr>().is_err() {
            return false;
        }
        (format!("[{inner}]"), after.strip_prefix(':'))
    } else {
        match entry.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), Some(port)),
            None => (entry.to_string(), None),
        }
    };
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|c| c.is_ascii_digit()));
    port_ok && (host.starts_with('[') || valid_dns_name(&host))
}

/// `http(s)://host[:port]` and nothing else.
fn valid_origin_entry(origin: &str) -> bool {
    origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .is_some_and(valid_host_entry)
}

fn bearer_token(headers: &hyper::HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer")
        && token.len() == 64
        && token.bytes().all(|c| c.is_ascii_hexdigit()))
    .then_some(token)
}

fn cors_origin(state: &State, headers: &hyper::HeaderMap) -> Option<String> {
    let origin = headers.get(header::ORIGIN)?.to_str().ok()?.to_ascii_lowercase();
    state.allowed_origins.contains(&origin).then_some(origin)
}

fn with_cors(mut response: Resp, origin: Option<&str>) -> Resp {
    if let Some(origin) = origin.and_then(|o| HeaderValue::from_str(o).ok()) {
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

fn preflight(origin: &str) -> Resp {
    let mut response = reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new());
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, POST, PUT, DELETE"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type"),
    );
    headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    response
}

fn no_content() -> Resp {
    reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new())
}

async fn blocking<T: serde::Serialize + Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Resp {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => json(&value),
        _ => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
    }
}

async fn resource_route(
    state: &State,
    method: &Method,
    path: &str,
    req: Request<Incoming>,
) -> Resp {
    let root = state.data_folder.clone();
    match (method.clone(), path) {
        (Method::GET, "/api/v1/projects") => blocking(move || resources::projects(&root)).await,
        (Method::PUT, "/api/v1/projects") => {
            let value = match read_json_value(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::set_projects(&root, value)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid projects"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save projects"),
            }
        }
        (Method::GET, "/api/v1/assistants") => {
            blocking(move || resources::assistants(&root)).await
        }
        (Method::POST, "/api/v1/assistants") => {
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::create_assistant(&root, value))
                .await
            {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid assistant"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save assistant"),
            }
        }
        (Method::DELETE, p) if p.starts_with("/api/v1/assistants/") => {
            let id = p["/api/v1/assistants/".len()..].to_owned();
            match tokio::task::spawn_blocking(move || resources::delete_assistant(&root, &id))
                .await
            {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid assistant id"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete assistant"),
            }
        }
        (Method::GET, p) if p.starts_with("/api/v1/provider-keys/") => {
            let name = p["/api/v1/provider-keys/".len()..].to_owned();
            blocking(move || resources::provider_keys(&name).map(|keys| serde_json::json!({ "keys": keys }))).await
        }
        (Method::PUT, p) if p.starts_with("/api/v1/provider-keys/") => {
            let name = p["/api/v1/provider-keys/".len()..].to_owned();
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::set_provider_keys(&name, &value)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid keys"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save keys"),
            }
        }
        (Method::DELETE, p) if p.starts_with("/api/v1/provider-keys/") => {
            let name = p["/api/v1/provider-keys/".len()..].to_owned();
            match tokio::task::spawn_blocking(move || resources::delete_provider_keys(&name)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid provider"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete keys"),
            }
        }
        (Method::POST, "/api/v1/secret-values") => {
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match resources::register_secret_values(&value) {
                Ok(()) => no_content(),
                Err(_) => text(StatusCode::BAD_REQUEST, "Invalid values"),
            }
        }
        (Method::GET, "/api/v1/engine/info") => json(&engine::info(&state.engine).await),
        (Method::GET, "/api/v1/engine/version") => json(&engine::version()),
        (Method::GET, "/api/v1/engine/devices") => match engine::devices(&state.engine).await {
            Ok(devices) => json(&devices),
            Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
        },
        (Method::POST, "/api/v1/engine/start") => {
            let body = match read_json_value(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let Ok(request) = serde_json::from_value::<engine::StartRequest>(body) else {
                return text(StatusCode::BAD_REQUEST, "Invalid engine request");
            };
            match engine::start(&state.engine, &state.data_folder, request).await {
                Ok(info) => json(&info),
                Err(message) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            }
        }
        (Method::POST, "/api/v1/engine/stop") => {
            engine::stop(&state.engine, false).await;
            no_content()
        }
        (Method::POST, "/api/v1/engine/force-stop") => {
            engine::stop(&state.engine, true).await;
            no_content()
        }
        (Method::GET, "/api/v1/hardware/info") => {
            blocking(|| Ok(tauri_plugin_hardware::get_system_info())).await
        }
        (Method::GET, "/api/v1/hardware/usage") => {
            blocking(|| Ok(tauri_plugin_hardware::sample_system_usage())).await
        }
        (Method::GET, "/api/v1/app/info") => json(&serde_json::json!({
            "dataFolder": state.data_folder.to_string_lossy(),
            "version": env!("CARGO_PKG_VERSION"),
            "headless": true,
        })),
        (Method::GET, "/api/v1/hardware/snapshot") => {
            blocking(|| Ok(tauri_plugin_hardware::snapshot::get_system_snapshot())).await
        }
        (Method::POST, "/api/v1/hardware/refresh") => {
            tauri_plugin_hardware::invalidate_system_info();
            no_content()
        }
        _ => text(StatusCode::NOT_FOUND, "Unknown API route"),
    }
}


fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    form_urlencoded::parse(query?.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn str_field<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(serde_json::Value::as_str)
}

fn result_response(result: Result<(), String>, failure: StatusCode) -> Resp {
    match result {
        Ok(()) => no_content(),
        Err(message) => reply(failure, "text/plain; charset=utf-8", message),
    }
}

async fn mcp_route(state: &State, method: &Method, rest: &str, req: Request<Incoming>) -> Resp {
    let query = req.uri().query().map(str::to_owned);
    let decoded: Option<Vec<String>> = rest.split('/').map(percent_decode).collect();
    let Some(decoded) = decoded else {
        return text(StatusCode::BAD_REQUEST, "Invalid path");
    };
    let parts: Vec<&str> = decoded.iter().map(String::as_str).collect();
    let host = &state.mcp;
    match (method.clone(), parts.as_slice()) {
        (Method::GET, ["config"]) => reply(StatusCode::OK, "application/json", mcp::config_text()),
        (Method::PUT, ["config"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let Some(configs) = str_field(&body, "configs") else {
                return text(StatusCode::BAD_REQUEST, "Expected a configs string");
            };
            result_response(mcp::save_config(host, configs).await, StatusCode::BAD_REQUEST)
        }
        (Method::POST, ["restart"]) => {
            mcp::restart_all(host).await;
            no_content()
        }
        (Method::GET, ["tools"]) => {
            let names = query_param(query.as_deref(), "servers").map(|list| {
                list.split(',')
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<String>>()
            });
            let start = query_param(query.as_deref(), "start").as_deref() == Some("true");
            json(&mcp::tools(host, names, start).await)
        }
        (Method::GET, ["summaries"]) => json(&mcp::summaries(host).await),
        (Method::GET, ["statuses"]) => json(&mcp::statuses(host).await),
        (Method::GET, ["connected"]) => json(&mcp::connected(host).await),
        (Method::GET, ["log", name]) => {
            let lines = query_param(query.as_deref(), "lines").and_then(|v| v.parse().ok());
            json(&mcp::log(name, lines))
        }
        (Method::POST, ["servers", name, "activate"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let Some(config) = body.get("config").cloned() else {
                return text(StatusCode::BAD_REQUEST, "Expected a config object");
            };
            let start = body
                .get("start")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            result_response(
                mcp::activate(host, name, config, start).await,
                StatusCode::BAD_REQUEST,
            )
        }
        (Method::POST, ["servers", name, "deactivate"]) => {
            result_response(mcp::deactivate(host, name).await, StatusCode::BAD_REQUEST)
        }
        (Method::POST, ["servers", name, "start"]) => {
            result_response(mcp::start(host, name).await, StatusCode::BAD_GATEWAY)
        }
        (Method::POST, ["servers", name, "stop"]) => {
            mcp::stop(host, name).await;
            no_content()
        }
        (Method::POST, ["call"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let Some(tool) = str_field(&body, "toolName") else {
                return text(StatusCode::BAD_REQUEST, "toolName is required");
            };
            let call = mcp::Call {
                tool,
                server: str_field(&body, "serverName").filter(|n| !n.is_empty()),
                arguments: body
                    .get("arguments")
                    .and_then(serde_json::Value::as_object)
                    .cloned(),
                cancellation_token: str_field(&body, "cancellationToken").map(str::to_owned),
                max_output_chars: body
                    .get("maxOutputChars")
                    .and_then(serde_json::Value::as_u64),
                approval_ticket: str_field(&body, "approvalTicket"),
            };
            // A refused or failed call is data for the chat, as on desktop.
            match mcp::call(host, call).await {
                Ok(result) => json(&result),
                Err(message) => json(&serde_json::json!({ "error": message, "content": [] })),
            }
        }
        (Method::POST, ["cancel"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            if let Some(token) = str_field(&body, "token") {
                mcp::cancel(host, token).await;
            }
            no_content()
        }
        (Method::GET, ["trust"]) => json(&mcp::trust_report()),
        (Method::GET, ["trust", "trusted"]) => json(&mcp::trusted()),
        (Method::GET, ["fingerprints"]) => json(&mcp::fingerprints()),
        (Method::POST, ["trust", name]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            result_response(
                mcp::trust(name, str_field(&body, "fingerprint")),
                StatusCode::CONFLICT,
            )
        }
        (Method::DELETE, ["trust", name]) => {
            result_response(mcp::revoke(name), StatusCode::BAD_REQUEST)
        }
        (Method::POST, ["forget", name]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            result_response(
                mcp::forget(name, str_field(&body, "reason").unwrap_or("")),
                StatusCode::BAD_REQUEST,
            )
        }
        (Method::POST, ["allow-once"]) => {
            let body = match read_json(req).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            let (Some(server), Some(tool)) =
                (str_field(&body, "serverName"), str_field(&body, "toolName"))
            else {
                return text(StatusCode::BAD_REQUEST, "serverName and toolName are required");
            };
            match mcp::allow_once(server, tool, str_field(&body, "fingerprint")) {
                Ok(ticket) => json(&serde_json::json!({ "ticket": ticket })),
                Err(message) => result_response(Err(message), StatusCode::CONFLICT),
            }
        }
        (Method::GET, ["auth", name]) => json(&mcp::auth_status(name)),
        (Method::DELETE, ["auth", name]) => match mcp::clear_auth(name) {
            Ok(cleared) => json(&serde_json::json!({ "cleared": cleared })),
            Err(message) => result_response(Err(message), StatusCode::BAD_REQUEST),
        },
        _ => text(StatusCode::NOT_FOUND, "Unknown API route"),
    }
}

/// Sign in for a client that is not a browser page (a native shell): the same
/// administrator credential, the same hashed session store and the same
/// attempt limit as the cookie flow, but the session comes back as JSON to be
/// sent in an `Authorization: Bearer` header.
async fn token_sign_in(state: &State, req: Request<Incoming>) -> Resp {
    if login_blocked(&mut state.login_failures.lock().unwrap()) {
        return text(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts");
    }
    let body = match Limited::new(req.into_body(), MAX_LOGIN_BODY).collect().await {
        Ok(body) => body.to_bytes(),
        Err(_) => return text(StatusCode::PAYLOAD_TOO_LARGE, "Request too large"),
    };
    let credential = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("credential").and_then(serde_json::Value::as_str).map(str::to_owned))
        .filter(|token| token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()));
    let Some(credential) = credential else {
        return text(StatusCode::BAD_REQUEST, "Invalid credential format");
    };
    let result = state.auth.lock().unwrap().sign_in(&credential);
    match result {
        Ok(Some(session)) => json(&serde_json::json!({
            "token": session,
            "expiresIn": 43200,
        })),
        Ok(None) => {
            state.login_failures.lock().unwrap().push_back(Instant::now());
            text(StatusCode::UNAUTHORIZED, "Invalid credential")
        }
        Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save session"),
    }
}

/// The Tauri commands the app's extensions call, answered for a browser.
/// Anything not listed is refused, so a command added to the desktop app does
/// not become reachable from a browser by accident.
async fn rpc_route(state: &State, command: &str, args: serde_json::Value) -> Resp {
    if files::handles(command) {
        let (root, command) = (state.data_folder.clone(), command.to_owned());
        return match tokio::task::spawn_blocking(move || files::call(&root, &command, &args)).await {
            Ok(Ok(value)) => json(&value),
            Ok(Err(message)) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
    }
    match command {
        "plugin:llamacpp|get_engine_info" => json(&engine::info(&state.engine).await),
        "plugin:llamacpp|get_engine_version" => json(&engine::version()),
        "plugin:llamacpp|stop_engine" => {
            engine::stop(&state.engine, false).await;
            json(&serde_json::Value::Null)
        }
        "plugin:llamacpp|force_stop_engine" => {
            engine::stop(&state.engine, true).await;
            json(&serde_json::Value::Null)
        }
        "plugin:llamacpp|engine_devices" => match engine::devices(&state.engine).await {
            Ok(devices) => json(&devices),
            Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
        },
        "plugin:llamacpp|start_engine" => {
            // The plugin's own argument names, so its guest API works unchanged.
            let request = engine::StartRequest {
                preset_path: str_field(&args, "presetPath").unwrap_or_default().to_owned(),
                models_max: args.get("modelsMax").and_then(serde_json::Value::as_u64).unwrap_or(1) as u32,
                slot_cache_mib: args.get("slotCacheMib").and_then(serde_json::Value::as_u64).unwrap_or(0),
                envs: args
                    .get("envs")
                    .and_then(serde_json::Value::as_object)
                    .map(|map| {
                        map.iter()
                            .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                            .collect()
                    })
                    .unwrap_or_default(),
            };
            match engine::start(&state.engine, &state.data_folder, request).await {
                Ok(info) => json(&serde_json::json!({
                    "port": info.port,
                    "api_key": info.api_key,
                    "pid": info.pid,
                    "models": info.models,
                })),
                Err(message) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            }
        }
        _ => text(StatusCode::NOT_FOUND, "Unknown command"),
    }
}

async fn route(state: Arc<State>, req: Request<Incoming>) -> Resp {
    if !host_allowed(&state, req.headers()) {
        return text(StatusCode::MISDIRECTED_REQUEST, "Unknown host");
    }
    let cors = cors_origin(&state, req.headers());
    if req.method() == Method::OPTIONS {
        return match &cors {
            Some(origin) if req.headers().contains_key(header::ACCESS_CONTROL_REQUEST_METHOD) => {
                preflight(origin)
            }
            _ => text(StatusCode::FORBIDDEN, "Cross-origin requests are not allowed"),
        };
    }
    with_cors(route_inner(state, req).await, cors.as_deref())
}

async fn route_inner(state: Arc<State>, req: Request<Incoming>) -> Resp {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    if path == "/healthz" && method == Method::GET {
        return text(StatusCode::OK, "ok");
    }
    // A bearer token is sent on purpose, never added by the browser, so a
    // request carrying one cannot be a cross-site forgery and needs no Origin.
    let has_bearer = bearer_token(req.headers()).is_some();
    if path == "/api/v1/token" && method == Method::POST {
        return token_sign_in(&state, req).await;
    }
    if method != Method::GET
        && method != Method::HEAD
        && !has_bearer
        && !same_origin(&state, req.headers())
    {
        return text(StatusCode::FORBIDDEN, "Invalid origin");
    }
    if path == "/login" && method == Method::GET {
        return reply(StatusCode::OK, "text/html; charset=utf-8", LOGIN_HTML);
    }
    if path == "/api/v1/session" && method == Method::POST {
        if login_blocked(&mut state.login_failures.lock().unwrap()) {
            return text(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts");
        }
        let req_host_for_cookie = req
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .map(str::to_ascii_lowercase);
        let body = match Limited::new(req.into_body(), MAX_LOGIN_BODY)
            .collect()
            .await
        {
            Ok(body) => body.to_bytes(),
            Err(_) => return text(StatusCode::PAYLOAD_TOO_LARGE, "Request too large"),
        };
        let Some(token) = std::str::from_utf8(&body)
            .ok()
            .and_then(|body| body.strip_prefix("credential="))
            .filter(|token| token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()))
        else {
            return text(StatusCode::BAD_REQUEST, "Invalid credential format");
        };
        let result = state.auth.lock().unwrap().sign_in(token);
        return match result {
            Ok(Some(session)) => {
                let mut response = reply(
                    StatusCode::SEE_OTHER,
                    "text/plain; charset=utf-8",
                    "Signed in",
                );
                response
                    .headers_mut()
                    .insert(header::LOCATION, HeaderValue::from_static("/"));
                let secure = state.public_host.as_deref() == req_host_for_cookie.as_deref();
                response.headers_mut().insert(header::SET_COOKIE,
                    HeaderValue::from_str(&format!("{COOKIE_NAME}={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{}", if secure { "; Secure" } else { "" }))
                        .expect("hex session cookie is valid"));
                response
            }
            Ok(None) => {
                state
                    .login_failures
                    .lock()
                    .unwrap()
                    .push_back(Instant::now());
                text(StatusCode::UNAUTHORIZED, "Invalid credential")
            }
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save session"),
        };
    }
    // An Authorization header decides on its own: a bad token is never
    // rescued by a cookie that happens to ride along.
    let presented_bearer = req.headers().contains_key(header::AUTHORIZATION);
    let session = if presented_bearer {
        bearer_token(req.headers())
    } else {
        session_cookie(req.headers())
    };
    let authorized = session.is_some_and(|token| state.auth.lock().unwrap().authorize(token));
    if !authorized {
        if !presented_bearer && (method == Method::GET || method == Method::HEAD) {
            let mut response = reply(
                StatusCode::SEE_OTHER,
                "text/plain; charset=utf-8",
                "Sign in required",
            );
            response
                .headers_mut()
                .insert(header::LOCATION, HeaderValue::from_static("/login"));
            return response;
        }
        return text(StatusCode::UNAUTHORIZED, "Sign in required");
    }
    if path == "/api/v1/session" {
        if method == Method::GET {
            return reply(
                StatusCode::OK,
                "application/json",
                r#"{"authenticated":true}"#,
            );
        }
        if method == Method::DELETE {
            if state
                .auth
                .lock()
                .unwrap()
                .sign_out(session.unwrap())
                .is_err()
            {
                return text(StatusCode::INTERNAL_SERVER_ERROR, "Could not end session");
            }
            let mut response = reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new());
            response.headers_mut().insert(
                header::SET_COOKIE,
                HeaderValue::from_static(
                    "flint_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
                ),
            );
            return response;
        }
    }
    if method == Method::POST && path == "/api/v1/threads" {
        let thread = match read_json(req).await {
            Ok(value) => value,
            Err(response) => return response,
        };
        let root = state.data_folder.clone();
        return match tokio::task::spawn_blocking(move || data::create_thread(&root, thread)).await {
            Ok(Ok(thread)) => json_created(&thread),
            _ => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not create thread"),
        };
    }
    if let Some(rest) = path.strip_prefix("/api/v1/threads/") {
        let parts: Vec<_> = rest.split('/').collect();
        if parts.iter().any(|part| crate::core::threads::utils::validate_thread_id(part).is_err()) {
            return text(StatusCode::BAD_REQUEST, "Invalid id");
        }
        match (method.clone(), parts.as_slice()) {
            (Method::PUT, [id]) => {
                let thread = match read_json(req).await {
                    Ok(value) => value,
                    Err(response) => return response,
                };
                if thread.get("id").and_then(serde_json::Value::as_str) != Some(*id) {
                    return text(StatusCode::BAD_REQUEST, "Thread id does not match URL");
                }
                let root = state.data_folder.clone();
                let id = (*id).to_owned();
                return match tokio::task::spawn_blocking(move || data::update_thread(&root, &id, thread)).await {
                    Ok(Ok(())) => reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new()),
                    Ok(Err(_)) => text(StatusCode::NOT_FOUND, "Thread not found"),
                    Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not update thread"),
                };
            }
            (Method::DELETE, [id]) => {
                let permanent = req.uri().query() == Some("permanent=true");
                return match data::delete_thread(&state.data_folder, id, permanent).await {
                    Ok(()) => reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new()),
                    Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete thread"),
                };
            }
            (Method::POST, [id, "messages"]) => {
                let message = match read_json(req).await {
                    Ok(value) => value,
                    Err(response) => return response,
                };
                if message.get("thread_id").and_then(serde_json::Value::as_str) != Some(*id) {
                    return text(StatusCode::BAD_REQUEST, "Message thread id does not match URL");
                }
                return match data::create_message(&state.data_folder, id, message).await {
                    Ok(message) => json_created(&message),
                    Err(_) => text(StatusCode::NOT_FOUND, "Thread not found"),
                };
            }
            (Method::PUT, [id, "messages", message_id]) => {
                let message = match read_json(req).await {
                    Ok(value) => value,
                    Err(response) => return response,
                };
                if message.get("thread_id").and_then(serde_json::Value::as_str) != Some(*id)
                    || message.get("id").and_then(serde_json::Value::as_str) != Some(*message_id)
                {
                    return text(StatusCode::BAD_REQUEST, "Message id does not match URL");
                }
                return match data::update_message(&state.data_folder, id, message_id, message).await {
                    Ok(message) => json(&message),
                    Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not update message"),
                };
            }
            (Method::DELETE, [id, "messages", message_id]) => {
                return match data::delete_message(&state.data_folder, id, message_id).await {
                    Ok(()) => reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new()),
                    Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete message"),
                };
            }
            _ => {}
        }
    }
    if path == "/api/v1/provider/stream" && method == Method::POST {
        return provider::stream(req).await;
    }
    if path == "/api/v1/provider/cancel" && method == Method::POST {
        return provider::cancel(req).await;
    }
    if path == "/api/v1/uploads" && method == Method::POST {
        let name = query_param(req.uri().query(), "name").unwrap_or_default();
        let body = match Limited::new(req.into_body(), uploads::MAX_UPLOAD_BYTES).collect().await {
            Ok(body) => body.to_bytes(),
            Err(_) => return text(StatusCode::PAYLOAD_TOO_LARGE, "File too large"),
        };
        let root = state.data_folder.clone();
        return match tokio::task::spawn_blocking(move || uploads::store(&root, &name, &body)).await {
            Ok(Ok(stored)) => json_created(&stored),
            _ => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not store upload"),
        };
    }
    if path == "/api/v1/uploads/parse" && method == Method::POST {
        let body = match read_json(req).await {
            Ok(body) => body,
            Err(response) => return response,
        };
        let (Some(file), kind) = (str_field(&body, "path"), str_field(&body, "type").unwrap_or("")) else {
            return text(StatusCode::BAD_REQUEST, "path is required");
        };
        let (root, file, kind) = (state.data_folder.clone(), file.to_owned(), kind.to_owned());
        return match tokio::task::spawn_blocking(move || uploads::parse(&root, &file, &kind)).await {
            Ok(Ok(parsed)) => json(&serde_json::json!({ "text": parsed })),
            Ok(Err(message)) => reply(StatusCode::UNPROCESSABLE_ENTITY, "text/plain; charset=utf-8", message),
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Parser failed"),
        };
    }
    if let Some(id) = path.strip_prefix("/api/v1/uploads/") {
        if method == Method::DELETE {
            let (root, id) = (state.data_folder.clone(), id.to_owned());
            return match tokio::task::spawn_blocking(move || uploads::delete(&root, &id)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid upload id"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete upload"),
            };
        }
    }
    if let Some(command) = path.strip_prefix("/api/v1/rpc/") {
        if method != Method::POST {
            return text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
        }
        let Some(command) = percent_decode(command) else {
            return text(StatusCode::BAD_REQUEST, "Invalid command");
        };
        let args = match read_json(req).await {
            Ok(args) => args,
            Err(response) => return response,
        };
        return rpc_route(&state, &command, args).await;
    }
    if let Some(rest) = path.strip_prefix("/api/v1/mcp/") {
        return mcp_route(&state, &method, rest, req).await;
    }
    if path.starts_with("/api/v1/projects")
        || path.starts_with("/api/v1/assistants")
        || path.starts_with("/api/v1/hardware")
        || path == "/api/v1/app/info"
        || path.starts_with("/api/v1/engine/")
        || path.starts_with("/api/v1/provider-keys/")
        || path == "/api/v1/secret-values"
    {
        return resource_route(&state, &method, &path, req).await;
    }
    if method == Method::GET && path == "/api/v1/threads" {
        let root = state.data_folder.clone();
        return match tokio::task::spawn_blocking(move || data::threads(&root)).await {
            Ok(Ok(threads)) => json(&threads),
            _ => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not list threads"),
        };
    }
    if method == Method::GET {
        if let Some(rest) = path.strip_prefix("/api/v1/threads/") {
            let (id, want_messages) = match rest.split_once('/') {
                Some((id, "messages")) => (id, true),
                None => (rest, false),
                _ => return text(StatusCode::NOT_FOUND, "Unknown API route"),
            };
            if crate::core::threads::utils::validate_thread_id(id).is_err() {
                return text(StatusCode::BAD_REQUEST, "Invalid thread id");
            }
            let id = id.to_owned();
            let root = state.data_folder.clone();
            return match tokio::task::spawn_blocking(move || {
                if want_messages {
                    data::messages(&root, &id).map(serde_json::Value::Array)
                } else {
                    data::thread(&root, &id)
                }
            })
            .await
            {
                Ok(Ok(value)) => json(&value),
                Ok(Err(_)) => text(StatusCode::NOT_FOUND, "Thread not found"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not read thread"),
            };
        }
    }
    if path.starts_with("/api/") {
        return text(StatusCode::NOT_FOUND, "Unknown API route");
    }
    if method != Method::GET && method != Method::HEAD {
        return text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    let rel = path.strip_prefix('/').unwrap_or(&path);
    let file = match static_files::resolve(&state.assets, rel) {
        Ok(file) => file,
        Err(StaticError::Forbidden) => return text(StatusCode::FORBIDDEN, "Forbidden path"),
        Err(StaticError::NotFound) => return text(StatusCode::NOT_FOUND, "Not found"),
    };
    let content_type = static_files::content_type(&file);
    let body = if method == Method::HEAD {
        Bytes::new()
    } else {
        match tokio::fs::read(file).await {
            Ok(data) => Bytes::from(data),
            Err(_) => return text(StatusCode::INTERNAL_SERVER_ERROR, "Could not read asset"),
        }
    };
    reply(StatusCode::OK, content_type, body)
}

const LOGIN_HTML: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flint sign in</title></head><body><main><h1>Flint</h1><form action="/api/v1/session" method="post"><label>Administrator credential <input name="credential" type="password" required autocomplete="current-password"></label><button type="submit">Sign in</button></form></main></body></html>"#;

pub async fn serve(options: Options) -> io::Result<()> {
    let loopback = options.bind.ip().is_loopback();
    if !loopback && options.allowed_hosts.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "binding beyond loopback needs at least one --allowed-host (the exact Host the clients use)",
        ));
    }
    if let Some(bad) = options.allowed_hosts.iter().find(|h| !valid_host_entry(h)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("--allowed-host {bad:?} must be host or host:port, with no scheme or wildcard"),
        ));
    }
    if let Some(bad) = options.allowed_origins.iter().find(|o| !valid_origin_entry(o)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("--allowed-origin {bad:?} must be http(s)://host[:port], with no wildcard"),
        ));
    }
    if !options.assets.join("index.html").is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "production web bundle is missing index.html",
        ));
    }
    let listener = TcpListener::bind(options.bind).await?;
    let port = listener.local_addr()?.port();
    let mut hosts = HashSet::from([
        format!("localhost:{port}"),
        format!("127.0.0.1:{port}"),
        format!("[::1]:{port}"),
    ]);
    if let Some(host) = &options.public_host {
        if !valid_dns_name(host) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "public host must be a DNS name without scheme or port",
            ));
        }
        hosts.insert(host.to_ascii_lowercase());
    }
    for host in &options.allowed_hosts {
        hosts.insert(host.to_ascii_lowercase());
    }
    let (auth, bootstrap) = AuthStore::open(options.auth_file)?;
    let state = Arc::new(State {
        auth: Mutex::new(auth),
        assets: options.assets,
        data_folder: options.data_folder,
        hosts,
        public_host: options.public_host.map(|host| host.to_ascii_lowercase()),
        login_failures: Mutex::new(VecDeque::new()),
        mcp: mcp::Host::new(options.allow_mcp_stdio),
        allowed_origins: options.allowed_origins.iter().map(|o| o.to_ascii_lowercase()).collect(),
        engine: engine::Supervisor::new(options.llama_worker.clone()),
    });
    eprintln!(
        "Flint web server listening on http://{}",
        listener.local_addr()?
    );
    if !loopback {
        eprintln!(
            "Warning: listening beyond loopback. Sessions travel in the clear unless a TLS proxy fronts this server."
        );
    }
    if let Some(credential) = bootstrap {
        eprintln!("First-run administrator credential: {credential}");
        eprintln!("Store this credential securely; it is shown only once.");
    }
    loop {
        let (socket, peer) = tokio::select! {
            accepted = listener.accept() => accepted?,
            _ = tokio::signal::ctrl_c() => {
                engine::stop(&state.engine, false).await;
                break;
            }
        };
        if loopback && !peer.ip().is_loopback() {
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(socket);
            let service = service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, std::convert::Infallible>(route(state, req).await) }
            });
            let _ = http1::Builder::new().serve_connection(io, service).await;
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_parser_requires_exact_hex_session() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("flint_session=short"),
        );
        assert!(session_cookie(&headers).is_none());
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("other=x; flint_session={}", "a".repeat(64))).unwrap(),
        );
        assert_eq!(session_cookie(&headers), Some("a".repeat(64).as_str()));
    }

    #[test]
    fn origins_must_name_configured_host() {
        let dir = tempfile::tempdir().unwrap();
        let (auth, _) = AuthStore::open(dir.path().join("auth.json")).unwrap();
        let state = State {
            auth: Mutex::new(auth),
            assets: dir.path().to_path_buf(),
            data_folder: dir.path().to_path_buf(),
            hosts: HashSet::from(["localhost:1340".to_string()]),
            public_host: None,
            login_failures: Mutex::new(VecDeque::new()),
            mcp: mcp::Host::new(false),
            allowed_origins: HashSet::new(),
            engine: engine::Supervisor::new(None),
        };
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:1340"),
        );
        assert!(same_origin(&state, &headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://evil.example"),
        );
        assert!(!same_origin(&state, &headers));
    }

    #[tokio::test]
    async fn non_loopback_bind_needs_an_allowed_host() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "ok").unwrap();
        let error = serve(Options {
            bind: "0.0.0.0:0".parse().unwrap(),
            assets: dir.path().to_path_buf(),
            data_folder: dir.path().to_path_buf(),
            auth_file: dir.path().join("auth.json"),
            public_host: None,
            allow_mcp_stdio: false,
            allowed_hosts: Vec::new(),
            allowed_origins: Vec::new(),
            llama_worker: None,
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn host_and_origin_entries_are_exact() {
        for good in ["phone.tail1234.ts.net", "192.168.1.5:1340", "localhost", "[fd7a::1]:1340"] {
            assert!(valid_host_entry(good), "{good}");
        }
        for bad in ["", "*", "*.example.com", "http://x", "a/b", "a:b", "host:", "a b", "[nope]:1"] {
            assert!(!valid_host_entry(bad), "{bad}");
        }
        assert!(valid_origin_entry("https://app.example.com"));
        assert!(valid_origin_entry("http://tauri.localhost"));
        for bad in ["*", "null", "https://*", "tauri://localhost", "https://a.b/path", "https://"] {
            assert!(!valid_origin_entry(bad), "{bad}");
        }
    }

    #[test]
    fn bearer_tokens_are_exact_hex_and_only_that_scheme() {
        let mut headers = hyper::HeaderMap::new();
        let token = "ab".repeat(32);
        headers.insert(header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
        assert_eq!(bearer_token(&headers), Some(token.as_str()));
        headers.insert(header::AUTHORIZATION, HeaderValue::from_str(&format!("bearer {token}")).unwrap());
        assert!(bearer_token(&headers).is_some());
        for bad in ["Basic abc", "Bearer short", &format!("Bearer {}g", "a".repeat(63)), &token] {
            headers.insert(header::AUTHORIZATION, HeaderValue::from_str(bad).unwrap());
            assert!(bearer_token(&headers).is_none(), "{bad}");
        }
    }

    #[tokio::test]
    async fn serving_beyond_loopback_needs_hosts_and_valid_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "ok").unwrap();
        let options = |hosts: Vec<&str>, origins: Vec<&str>| Options {
            bind: "0.0.0.0:0".parse().unwrap(),
            assets: dir.path().to_path_buf(),
            data_folder: dir.path().to_path_buf(),
            auth_file: dir.path().join("auth.json"),
            public_host: None,
            allow_mcp_stdio: false,
            allowed_hosts: hosts.into_iter().map(String::from).collect(),
            allowed_origins: origins.into_iter().map(String::from).collect(),
            llama_worker: None,
        };
        let none = serve(options(vec![], vec![])).await.unwrap_err();
        assert!(none.to_string().contains("--allowed-host"));
        let wildcard = serve(options(vec!["*"], vec![])).await.unwrap_err();
        assert!(wildcard.to_string().contains("--allowed-host"));
        let origin = serve(options(vec!["phone.example"], vec!["*"])).await.unwrap_err();
        assert!(origin.to_string().contains("--allowed-origin"));
    }

    #[test]
    fn cors_applies_only_to_listed_origins() {
        let dir = tempfile::tempdir().unwrap();
        let (auth, _) = AuthStore::open(dir.path().join("auth.json")).unwrap();
        let state = State {
            auth: Mutex::new(auth),
            assets: dir.path().to_path_buf(),
            data_folder: dir.path().to_path_buf(),
            hosts: HashSet::new(),
            public_host: None,
            login_failures: Mutex::new(VecDeque::new()),
            mcp: mcp::Host::new(false),
            allowed_origins: HashSet::from(["http://tauri.localhost".to_string()]),
            engine: engine::Supervisor::new(None),
        };
        let mut headers = hyper::HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://Tauri.localhost"));
        assert_eq!(cors_origin(&state, &headers).as_deref(), Some("http://tauri.localhost"));
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://evil.example"));
        assert!(cors_origin(&state, &headers).is_none());
        let response = with_cors(text(StatusCode::OK, "x"), Some("http://tauri.localhost"));
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "http://tauri.localhost"
        );
        assert!(response.headers().get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
        let none = with_cors(text(StatusCode::OK, "x"), None);
        assert!(none.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[test]
    fn html_policy_allows_app_styles_but_blocks_foreign_scripts() {
        let response = reply(StatusCode::OK, "text/html", "ok");
        let policy = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(policy.contains("style-src 'self' 'unsafe-inline'"));
        assert!(policy.contains("script-src 'self'"));
        assert!(policy.contains("object-src 'none'"));
    }
}
