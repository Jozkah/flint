//! Loopback listener for Flint's production browser bundle.
//!
//! Bind only to loopback. A private-network TLS proxy such as Tailscale Serve
//! can publish it; the proxy's exact public host must be configured here.

use std::collections::HashSet;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use super::agent;
use super::auth::AuthStore;
use super::data;
use super::control;
use super::engine;
use super::limiter::{client_ip, LoginLimiter};
use super::events;
use super::files;
use super::mcp;
use super::provider;
use super::resources;
use super::rooms;
use super::settings;
use super::uploads;
use super::static_files::{self, StaticError};

pub(super) type Resp = Response<UnsyncBoxBody<Bytes, std::convert::Infallible>>;
const MAX_LOGIN_BODY: usize = 4 * 1024;
const MAX_JSON_BODY: usize = 1024 * 1024;
/// A body that may carry pictures: a chat message with attachments, or the
/// provider request that sends them.
pub(super) const MAX_LARGE_JSON_BODY: usize = 64 * 1024 * 1024;
/// Time a client gets to deliver a whole sign-in body.
const LOGIN_BODY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
/// Time a client gets to deliver a whole JSON body.
const JSON_BODY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
/// Time a client gets to deliver a whole upload (up to 100 MiB, so generous).
const UPLOAD_BODY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(600);
/// Open connections the headless server serves at once.
const MAX_CONNECTIONS: usize = 256;
const COOKIE_NAME: &str = "flint_session";

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
    /// Folders the agent review plane may touch (`--agent-root`). Empty keeps
    /// it off.
    pub agent_roots: Vec<PathBuf>,
    /// `--agent-run`: let the server run agent sessions (needs a root).
    pub agent_run: bool,
    /// What the runner allows (`--agent-max-sessions` and the rest).
    pub agent_runner: super::runner::RunnerOptions,
    /// Extra exact `host[:port]` values accepted in the Host header; required
    /// when binding beyond loopback.
    pub allowed_hosts: Vec<String>,
    /// Exact origins (`https://host[:port]`) that may call the API from another
    /// origin with a bearer token. Never a wildcard.
    pub allowed_origins: Vec<String>,
    /// The `flint-llama-worker` binary to supervise for local inference.
    pub llama_worker: Option<PathBuf>,
    /// Where to leave the first-run credential instead of printing it, for a
    /// server started in the background by `flint serve --background`.
    pub credential_file: Option<PathBuf>,
    /// `--trust-proxy`: a proxy on this machine fronts the server, so the
    /// `X-Forwarded-For` it sets on loopback connections names the client.
    pub trust_proxy: bool,
}

struct State {
    auth: Mutex<AuthStore>,
    assets: PathBuf,
    data_folder: PathBuf,
    hosts: HashSet<String>,
    public_host: Option<String>,
    limiter: LoginLimiter,
    mcp: mcp::Host,
    agent: Option<agent::Agent>,
    allowed_origins: HashSet<String>,
    engine: engine::Supervisor,
    settings: settings::Store,
    events: events::Bus,
    /// Set to ask the accept loop to finish: `flint stop`.
    shutdown: Arc<tokio::sync::Notify>,
    shutdown_token: String,
    trust_proxy: bool,
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
        // `same-origin`, not `no-referrer`: under no-referrer a browser sends
        // `Origin: null` on a form post, and the sign-in form could never pass the
        // origin check. Nothing is sent to other origins either way.
        .header("referrer-policy", "same-origin")
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

/// The whole body, or the status to refuse with: 413 over `max` bytes, 408 when
/// the client has not finished sending within `deadline` (a trickling client
/// would otherwise hold the connection and its buffer open).
async fn collect_limited<B>(
    body: B,
    max: usize,
    deadline: std::time::Duration,
) -> Result<Bytes, StatusCode>
where
    B: hyper::body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    match tokio::time::timeout(deadline, Limited::new(body, max).collect()).await {
        Ok(Ok(collected)) => Ok(collected.to_bytes()),
        Ok(Err(_)) => Err(StatusCode::PAYLOAD_TOO_LARGE),
        Err(_) => Err(StatusCode::REQUEST_TIMEOUT),
    }
}

#[allow(clippy::result_large_err)]
async fn read_json(req: Request<Incoming>) -> Result<serde_json::Value, Resp> {
    read_json_max(req, MAX_JSON_BODY).await
}

/// A JSON object body of up to `max` bytes. Messages that carry pictures and
/// the provider request that sends them are far over the default limit.
#[allow(clippy::result_large_err)]
async fn read_json_max(req: Request<Incoming>, max: usize) -> Result<serde_json::Value, Resp> {
    let value = read_json_value_max(req, max).await?;
    if !value.is_object() {
        return Err(text(StatusCode::BAD_REQUEST, "Expected JSON object"));
    }
    Ok(value)
}

#[allow(clippy::result_large_err)]
pub(super) async fn read_json_value(req: Request<Incoming>) -> Result<serde_json::Value, Resp> {
    read_json_value_max(req, MAX_JSON_BODY).await
}

/// Like `read_json_value`, for a route that is allowed a larger body.
#[allow(clippy::result_large_err)]
pub(super) async fn read_json_value_max(
    req: Request<Incoming>,
    max: usize,
) -> Result<serde_json::Value, Resp> {
    let is_json = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json")));
    if !is_json {
        return Err(text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Expected application/json"));
    }
    let body = collect_limited(req.into_body(), max, JSON_BODY_DEADLINE).await
        .map_err(|status| text(status, "Request too large or too slow"))?;
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

/// An `Origin` that is present, is not `null`, and is not one of this server's
/// own names.
fn foreign_origin(state: &State, headers: &hyper::HeaderMap) -> bool {
    match headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
        None => false,
        Some("null") => false,
        Some(_) => !same_origin(state, headers),
    }
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

/// Whether the session cookie should be `Secure`: the request came to the
/// configured public host, or its Origin is an https one for a host this server
/// answers to (a TLS proxy on a port other than 443 forwards `host:port`, which
/// a bare `--public-host` name does not match).
fn cookie_secure(state: &State, headers: &hyper::HeaderMap) -> bool {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(str::to_ascii_lowercase);
    if state.public_host.is_some() && state.public_host == host {
        return true;
    }
    headers
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
        .and_then(|origin| origin.strip_prefix("https://"))
        .is_some_and(|origin_host| state.hosts.contains(&origin_host.to_ascii_lowercase()))
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
        (Method::POST, "/api/v1/projects") => {
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::add_project(&root, value)).await {
                Ok(Ok(project)) => json_created(&project),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid project"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save project"),
            }
        }
        (Method::PUT, p) if p.starts_with("/api/v1/projects/") => {
            let id = p["/api/v1/projects/".len()..].to_owned();
            let value = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return response,
            };
            match tokio::task::spawn_blocking(move || resources::update_project(&root, &id, value)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::NOT_FOUND, "No such project"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save project"),
            }
        }
        (Method::DELETE, p) if p.starts_with("/api/v1/projects/") => {
            let id = p["/api/v1/projects/".len()..].to_owned();
            match tokio::task::spawn_blocking(move || resources::delete_project(&root, &id)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid project id"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete project"),
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
async fn token_sign_in(state: &State, req: Request<Incoming>, client: std::net::IpAddr) -> Resp {
    if state.limiter.blocked(client) {
        return text(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts");
    }
    let body = match collect_limited(req.into_body(), MAX_LOGIN_BODY, LOGIN_BODY_DEADLINE).await {
        Ok(body) => body,
        Err(status) => return text(status, "Request too large or too slow"),
    };
    let credential = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("credential").and_then(serde_json::Value::as_str).map(str::to_owned))
        .filter(|token| token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()));
    let Some(credential) = credential else {
        return text(StatusCode::BAD_REQUEST, "Invalid credential format");
    };
    let wait = state.limiter.delay(client);
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    let result = state.auth.lock().unwrap_or_else(|p| p.into_inner()).sign_in(&credential);
    match result {
        Ok(Some(session)) => {
            state.limiter.record_success(client);
            json(&serde_json::json!({
            "token": session,
            "expiresIn": 43200,
            }))
        }
        Ok(None) => {
            state.limiter.record_failure(client);
            text(StatusCode::UNAUTHORIZED, "Invalid credential")
        }
        Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not save session"),
    }
}

/// A model file a browser names for inspection. Imported models can live
/// anywhere the operator put them, so a `.gguf` file is read where it is; every
/// other path has to be inside the data folder, and a URL is never fetched.
fn gguf_path(data_folder: &std::path::Path, args: &serde_json::Value) -> Result<String, String> {
    let raw = str_field(args, "path").ok_or("path is required")?;
    if raw.contains("://") && !raw.starts_with("file:") {
        return Err("remote model paths are not read by the server".into());
    }
    if let Ok(inside) = files::confine(data_folder, raw) {
        return Ok(inside.to_string_lossy().into_owned());
    }
    let path = std::path::Path::new(raw);
    let is_gguf = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("gguf"));
    if is_gguf && path.is_absolute() && path.is_file() {
        Ok(raw.to_owned())
    } else {
        Err("path must be a .gguf file or inside the data folder".into())
    }
}

/// The plugin's own error type, serialized the way the desktop app sends it so
/// the extension's error handling sees the same shape.
fn plugin_error(error: &tauri_plugin_llamacpp::error::ServerError) -> Resp {
    let body = serde_json::to_vec(error).unwrap_or_else(|_| b"{}".to_vec());
    reply(StatusCode::BAD_GATEWAY, "application/json", body)
}

/// The Tauri commands the app's extensions call, answered for a browser.
/// Anything not listed is refused, so a command added to the desktop app does
/// not become reachable from a browser by accident.
async fn rpc_route(
    state: &State,
    command: &str,
    args: serde_json::Value,
    caller: &super::runner::Caller,
) -> Resp {
    if command.starts_with("remote_") {
        // Remote access (phone pairing) is the desktop app's; see `phone_client_page`.
        return text(
            StatusCode::NOT_FOUND,
            "Phone pairing needs the Flint desktop app; a headless server does not offer remote access.",
        );
    }
    if super::campaign_driver::handles(command) {
        let Some(agent) = &state.agent else {
            return text(
                StatusCode::FORBIDDEN,
                "The agent review plane is off on this server. Start it with --agent-root <folder>.",
            );
        };
        return match agent.call_campaign(command, &args, caller).await {
            Ok(value) => json(&value),
            Err(failure) => {
                let status = StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_REQUEST);
                match failure.body {
                    serde_json::Value::String(message) => {
                        reply(status, "text/plain; charset=utf-8", message)
                    }
                    other => reply(
                        status,
                        "application/json",
                        serde_json::to_vec(&other).unwrap_or_default(),
                    ),
                }
            }
        };
    }
    if super::runner::handles(command) {
        let Some(agent) = &state.agent else {
            return text(
                StatusCode::FORBIDDEN,
                "The agent review plane is off on this server. Start it with --agent-root <folder>.",
            );
        };
        return match agent.call_run(command, &args, caller).await {
            Ok(value) => json(&value),
            Err(failure) => {
                let status = StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_REQUEST);
                match failure.body {
                    serde_json::Value::String(message) => {
                        reply(status, "text/plain; charset=utf-8", message)
                    }
                    other => reply(
                        status,
                        "application/json",
                        serde_json::to_vec(&other).unwrap_or_default(),
                    ),
                }
            }
        };
    }
    if files::handles(command) {
        let (root, command) = (state.data_folder.clone(), command.to_owned());
        return match tokio::task::spawn_blocking(move || files::call(&root, &command, &args)).await {
            Ok(Ok(value)) => json(&value),
            Ok(Err(message)) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
    }
    if rooms::handles(command) {
        let (root, command) = (state.data_folder.clone(), command.to_owned());
        return match tokio::task::spawn_blocking(move || rooms::call(&root, &command, &args)).await {
            Ok(Ok(value)) => json(&value),
            Ok(Err(message)) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
    }
    if settings::handles(command) {
        return match settings::call(&state.settings, command, &args) {
            Ok(value) => json(&value),
            Err(message) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
        };
    }
    if agent::handles(command) {
        let Some(agent) = &state.agent else {
            // Said once, plainly, so a client can show it rather than guess.
            if command == "agent_server_info" {
                return json(&serde_json::json!({ "agent": false, "folders": [] }));
            }
            return text(
                StatusCode::FORBIDDEN,
                "The agent review plane is off on this server. Start it with --agent-root <folder>.",
            );
        };
        let (agent, command) = (agent.clone(), command.to_owned());
        // Reads and writes files for a proposal, so not on the async threads.
        let outcome = match tokio::task::spawn_blocking(move || agent.call(&command, &args)).await {
            Ok(outcome) => outcome,
            Err(_) => return text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
        return match outcome {
            Ok(value) => json(&value),
            Err(failure) => {
                let status = StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_REQUEST);
                match failure.body {
                    serde_json::Value::String(message) => {
                        reply(status, "text/plain; charset=utf-8", message)
                    }
                    other => reply(
                        status,
                        "application/json",
                        serde_json::to_vec(&other).unwrap_or_default(),
                    ),
                }
            }
        };
    }
    match command {
        // The skills and slash-command catalogue are the desktop agent's. A
        // browser session has none, which is an answer the pages handle (an
        // empty list), where an unknown command stopped a room before it began.
        "agent_resolve_extensions" | "agent_slash_catalog" => json(&serde_json::json!([])),
        "search_messages" => {
            let query = str_field(&args, "query").unwrap_or_default().to_owned();
            let limit = args.get("limit").and_then(serde_json::Value::as_u64).unwrap_or(30) as usize;
            let root = state.data_folder.clone();
            blocking(move || crate::core::threads::search::search_messages_in(&root, &query, limit)).await
        }
        "get_secret" => {
            let key = str_field(&args, "key").unwrap_or_default().to_owned();
            match tokio::task::spawn_blocking(move || resources::get_secret(&key)).await {
                Ok(value) => json(&value),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
            }
        }
        "set_secret" => {
            let (Some(key), Some(value)) = (str_field(&args, "key"), str_field(&args, "value")) else {
                return text(StatusCode::BAD_REQUEST, "key and value are required");
            };
            let (key, value) = (key.to_owned(), value.to_owned());
            match tokio::task::spawn_blocking(move || resources::set_secret(&key, &value)).await {
                Ok(Ok(())) => json(&serde_json::Value::Null),
                Ok(Err(message)) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
            }
        }
        "archive_get_settings" => json(&serde_json::json!(crate::core::archive::store::read_settings(&state.data_folder))),
        "plugin:hardware|get_system_info" => {
            blocking(|| Ok(tauri_plugin_hardware::get_system_info())).await
        }
        "plugin:hardware|get_system_usage" => {
            blocking(|| Ok(tauri_plugin_hardware::sample_system_usage())).await
        }
        "plugin:llamacpp|generate_api_key" => {
            let (Some(model), Some(secret)) = (str_field(&args, "modelId"), str_field(&args, "apiSecret")) else {
                return text(StatusCode::BAD_REQUEST, "modelId and apiSecret are required");
            };
            match tauri_plugin_llamacpp::commands::generate_api_key(model.to_owned(), secret.to_owned()) {
                Ok(key) => json(&key),
                Err(message) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|load_llama_model" | "plugin:llamacpp|ensure_session_ready" => {
            let Some(model) = str_field(&args, "modelId") else {
                return text(StatusCode::BAD_REQUEST, "modelId is required");
            };
            let embedding = args.get("isEmbedding").and_then(serde_json::Value::as_bool).unwrap_or(false);
            let sink = state.events.clone();
            // The plugin's own error type, serialized as the desktop app sends it.
            match tauri_plugin_llamacpp::commands::load_model(&sink, &state.engine.state, model.to_owned(), embedding).await {
                Ok(session) => json(&session),
                Err(error) => plugin_error(&error),
            }
        }
        "plugin:llamacpp|unload_llama_model" => {
            let Some(model) = str_field(&args, "modelId") else {
                return text(StatusCode::BAD_REQUEST, "modelId is required");
            };
            match tauri_plugin_llamacpp::commands::unload_model(&state.engine.state, model.to_owned()).await {
                Ok(result) => json(&result),
                Err(error) => plugin_error(&error),
            }
        }
        "plugin:llamacpp|find_session_by_model" => {
            let Some(model) = str_field(&args, "modelId") else {
                return text(StatusCode::BAD_REQUEST, "modelId is required");
            };
            match tauri_plugin_llamacpp::commands::find_session(&state.engine.state, model.to_owned()).await {
                Ok(session) => json(&session),
                Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|get_loaded_models" => {
            match tauri_plugin_llamacpp::commands::loaded_models(&state.engine.state).await {
                Ok(ids) => json(&ids),
                Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|reload_engine_models" => {
            let preset = match engine::confine_preset(&state.data_folder, str_field(&args, "presetPath").unwrap_or_default()) {
                Ok(path) => path.to_string_lossy().into_owned(),
                Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            };
            let models_max = args.get("modelsMax").and_then(serde_json::Value::as_u64).map(|v| v as u32);
            let slot_cache = args.get("slotCacheMib").and_then(serde_json::Value::as_u64);
            let idle_unload = args.get("idleUnloadMinutes").and_then(serde_json::Value::as_u64).map(|v| v as u32);
            match tauri_plugin_llamacpp::engine::commands::reload_models(&state.engine.state, preset, models_max, slot_cache, idle_unload).await {
                Ok(report) => json(&report),
                Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|engine_slots_idle" => {
            let model = str_field(&args, "modelId").map(str::to_owned);
            match tauri_plugin_llamacpp::engine::commands::slots_idle(&state.engine.state, model).await {
                Ok(idle) => json(&idle),
                Err(message) => reply(StatusCode::BAD_GATEWAY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|erase_thread_slot_state" => {
            let cache_dir = match str_field(&args, "cacheDir") {
                Some(dir) => match files::confine(&state.data_folder, dir) {
                    Ok(path) => Some(path.to_string_lossy().into_owned()),
                    Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
                },
                None => None,
            };
            let thread = str_field(&args, "threadId").map(str::to_owned);
            let model = str_field(&args, "modelId").map(str::to_owned);
            match tauri_plugin_llamacpp::engine::commands::erase_slot_state(&state.engine.state, thread, model, cache_dir).await {
                Ok(count) => json(&count),
                Err(message) => reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|read_gguf_metadata" => {
            let path = match gguf_path(&state.data_folder, &args) {
                Ok(path) => path,
                Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            };
            match tauri_plugin_llamacpp::gguf::commands::read_gguf_metadata(path).await {
                Ok(metadata) => json(&metadata),
                Err(message) => reply(StatusCode::UNPROCESSABLE_ENTITY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|find_gguf_tensors" => {
            let path = match gguf_path(&state.data_folder, &args) {
                Ok(path) => path,
                Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            };
            let names: Vec<String> = args
                .get("names")
                .and_then(serde_json::Value::as_array)
                .map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            match tauri_plugin_llamacpp::gguf::commands::find_gguf_tensors(path, names).await {
                Ok(found) => json(&found),
                Err(message) => reply(StatusCode::UNPROCESSABLE_ENTITY, "text/plain; charset=utf-8", message),
            }
        }
        "plugin:llamacpp|is_model_supported" => {
            let path = match gguf_path(&state.data_folder, &args) {
                Ok(path) => path,
                Err(message) => return reply(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", message),
            };
            let ctx = args.get("ctxSize").and_then(serde_json::Value::as_u64).map(|v| v as u32);
            let key = str_field(&args, "cacheTypeK").map(str::to_owned);
            let value = str_field(&args, "cacheTypeV").map(str::to_owned);
            let no_kv_offload = args.get("noKvOffload").and_then(serde_json::Value::as_bool);
            match tauri_plugin_llamacpp::gguf::commands::is_model_supported(path, ctx, key, value, no_kv_offload).await {
                Ok(status) => json(&status),
                Err(message) => reply(StatusCode::UNPROCESSABLE_ENTITY, "text/plain; charset=utf-8", message),
            }
        }
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

async fn route(state: Arc<State>, req: Request<Incoming>, peer: std::net::IpAddr) -> Resp {
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
    let client = client_ip(
        peer,
        req.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok()),
        state.trust_proxy,
    );
    with_cors(route_inner(state, req, client).await, cors.as_deref())
}

async fn route_inner(state: Arc<State>, req: Request<Incoming>, client: std::net::IpAddr) -> Resp {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    if path == "/healthz" && method == Method::GET {
        return text(StatusCode::OK, "ok");
    }
    if path == "/api/v1/shutdown" && method == Method::POST {
        // Only `flint stop` knows this: the token lives in a file private to the
        // account running the server.
        let presented = req
            .headers()
            .get(control::SHUTDOWN_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let expected = state.shutdown_token.as_str();
        let matches = !expected.is_empty()
            && presented.len() == expected.len()
            && presented
                .bytes()
                .zip(expected.bytes())
                .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                == 0;
        if !matches {
            return text(StatusCode::FORBIDDEN, "Not allowed");
        }
        state.shutdown.notify_one();
        return no_content();
    }
    // A page on another site can post well-formed junk to a local server and
    // use up the sign-in attempts of the person it is open for. A request that
    // names a foreign origin never gets as far as the limiter. (`Origin: null`
    // is what a browser sends on some legitimate form posts, so it passes.)
    if (path == "/api/v1/token" || path == "/api/v1/session")
        && method == Method::POST
        && foreign_origin(&state, req.headers())
    {
        return text(StatusCode::FORBIDDEN, "Invalid origin");
    }
    // A bearer token is sent on purpose, never added by the browser, so a
    // request carrying one cannot be a cross-site forgery and needs no Origin.
    let has_bearer = bearer_token(req.headers()).is_some();
    if path == "/api/v1/token" && method == Method::POST {
        return token_sign_in(&state, req, client).await;
    }
    // Signing in is exempt: its body carries the administrator credential, which
    // a forged cross-site post cannot supply, and browsers send `Origin: null`
    // on a form post in several situations (referrer policy, privacy settings,
    // extensions) that would otherwise lock a legitimate user out.
    let sign_in = path == "/api/v1/session" && method == Method::POST;
    if method != Method::GET
        && method != Method::HEAD
        && !has_bearer
        && !sign_in
        && !same_origin(&state, req.headers())
    {
        // Said once on the console: the usual cause is a client reaching the
        // server under a name that was not passed with --allowed-host.
        let seen = |name| {
            req.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("(none)")
                .to_owned()
        };
        eprintln!(
            "refused {method} {path}: Origin {:?}, Host {:?}",
            seen(header::ORIGIN),
            seen(header::HOST)
        );
        return text(StatusCode::FORBIDDEN, "Invalid origin");
    }
    if path == "/login" && method == Method::GET {
        let error = req
            .uri()
            .query()
            .and_then(|q| form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "error"))
            .map(|(_, v)| v.into_owned());
        return reply(
            StatusCode::OK,
            "text/html; charset=utf-8",
            login_page(error.as_deref()),
        );
    }
    if path == "/api/v1/session" && method == Method::POST {
        // A browser form is sent back to the sign-in page with a notice; any
        // other client gets the status code.
        let is_form = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/x-www-form-urlencoded"));
        let refuse = |status: StatusCode, code: &str, message: &'static str| -> Resp {
            if is_form {
                let mut response = reply(StatusCode::SEE_OTHER, "text/plain; charset=utf-8", "Sign in failed");
                if let Ok(location) = HeaderValue::from_str(&format!("/login?error={code}")) {
                    response.headers_mut().insert(header::LOCATION, location);
                }
                response
            } else {
                text(status, message)
            }
        };
        if state.limiter.blocked(client) {
            return refuse(StatusCode::TOO_MANY_REQUESTS, "rate", "Too many sign-in attempts");
        }
        let secure = cookie_secure(&state, req.headers());
        let body = match collect_limited(req.into_body(), MAX_LOGIN_BODY, LOGIN_BODY_DEADLINE).await {
            Ok(body) => body,
            Err(status) => return text(status, "Request too large or too slow"),
        };
        let Some(token) = std::str::from_utf8(&body)
            .ok()
            .and_then(|body| body.strip_prefix("credential="))
            .filter(|token| token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()))
        else {
            return refuse(StatusCode::BAD_REQUEST, "format", "Invalid credential format");
        };
        let wait = state.limiter.delay(client);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        let result = state.auth.lock().unwrap_or_else(|p| p.into_inner()).sign_in(token);
        return match result {
            Ok(Some(session)) => {
                state.limiter.record_success(client);
                let mut response = reply(
                    StatusCode::SEE_OTHER,
                    "text/plain; charset=utf-8",
                    "Signed in",
                );
                response
                    .headers_mut()
                    .insert(header::LOCATION, HeaderValue::from_static("/"));
                response.headers_mut().insert(header::SET_COOKIE,
                    HeaderValue::from_str(&format!("{COOKIE_NAME}={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{}", if secure { "; Secure" } else { "" }))
                        .expect("hex session cookie is valid"));
                response
            }
            Ok(None) => {
                state.limiter.record_failure(client);
                refuse(StatusCode::UNAUTHORIZED, "invalid", "Invalid credential")
            }
            Err(_) => refuse(StatusCode::INTERNAL_SERVER_ERROR, "server", "Could not save session"),
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
    let authorized = session.is_some_and(|token| state.auth.lock().unwrap_or_else(|p| p.into_inner()).authorize(token));
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
    if path == "/api/v1/sessions" && method == Method::DELETE {
        // Sign every browser session out, this one included. The credential
        // stays; `flint serve --rotate-credential` replaces that.
        let revoked = state.auth.lock().unwrap_or_else(|p| p.into_inner()).revoke_all();
        if revoked.is_err() {
            return text(StatusCode::INTERNAL_SERVER_ERROR, "Could not end sessions");
        }
        let mut response = reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new());
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_static("flint_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
        );
        return response;
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
                let message = match read_json_max(req, MAX_LARGE_JSON_BODY).await {
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
                let message = match read_json_max(req, MAX_LARGE_JSON_BODY).await {
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
    if method == Method::GET && path.starts_with("/api/v1/agent/sessions/") && path.ends_with("/events") {
        let id = path["/api/v1/agent/sessions/".len()..path.len() - "/events".len()].to_owned();
        let Some(agent) = state.agent.clone() else {
            return text(
                StatusCode::FORBIDDEN,
                "The agent review plane is off on this server. Start it with --agent-root <folder>.",
            );
        };
        let after = crate::core::web_server::agent_runs::resume_point(
            query_param(req.uri().query(), "after").as_deref(),
            req.headers().get("last-event-id").and_then(|v| v.to_str().ok()),
        );
        // A session that is live here streams: replay, then the tail.
        if let Some(live) = agent.tail(&id, after) {
            return live;
        }
        return match tokio::task::spawn_blocking(move || agent.replay(&id, after)).await {
            Ok(Ok(body)) => reply(StatusCode::OK, "text/event-stream", body),
            Ok(Err(failure)) => {
                let status = StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_REQUEST);
                reply(status, "text/plain; charset=utf-8", failure.body.as_str().unwrap_or("Request failed").to_owned())
            }
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
        };
    }
    if path == "/api/v1/events" && method == Method::GET {
        return events::stream(&state.events);
    }
    if path == "/api/v1/provider/stream" && method == Method::POST {
        return provider::stream(req).await;
    }
    if path == "/api/v1/provider/cancel" && method == Method::POST {
        return provider::cancel(req).await;
    }
    if path == "/api/v1/uploads" && method == Method::POST {
        let name = query_param(req.uri().query(), "name").unwrap_or_default();
        let body = match collect_limited(req.into_body(), uploads::MAX_UPLOAD_BYTES, UPLOAD_BODY_DEADLINE).await {
            Ok(body) => body,
            Err(status) => return text(status, "File too large or too slow"),
        };
        let root = state.data_folder.clone();
        return match tokio::task::spawn_blocking(move || uploads::store(&root, &name, &body)).await {
            Ok(Ok(stored)) => json_created(&stored),
            Ok(Err(uploads::StoreError::OverQuota)) => {
                text(StatusCode::INSUFFICIENT_STORAGE, "Upload storage is full")
            }
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
        let caller = super::runner::Caller::digest(session.unwrap_or(""), client);
        // A message with pictures or files is far over the default body; the
        // checks that bound it (image caps, text caps, the line cap) are the
        // runner's, so only this one command is let through at the large size.
        let limit = if command == "agent_run_start" { MAX_LARGE_JSON_BODY } else { MAX_JSON_BODY };
        let args = match read_json_max(req, limit).await {
            Ok(args) => args,
            Err(response) => return response,
        };
        return rpc_route(&state, &command, args, &caller).await;
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
    if let Some(resp) = phone_client_page(&path) {
        return resp;
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

/// The phone app (`/m/`) and its pairing API (`/remote/v1/*`) belong to the
/// desktop app's remote-access server: phone calls are run by the desktop
/// window's TypeScript, which `flint serve` does not have. Rather than serve
/// the web app's shell there (a phone page stuck on "not paired"), say so.
fn phone_client_page(path: &str) -> Option<Resp> {
    let phone = path == "/m" || path.starts_with("/m/") || path == "/remote" || path.starts_with("/remote/");
    phone.then(|| reply(StatusCode::NOT_FOUND, "text/html; charset=utf-8", PHONE_NOT_HERE_HTML))
}

const PHONE_NOT_HERE_HTML: &str = "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Phone app not available</title><body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem\"><h1>Phone pairing needs the Flint desktop app</h1><p>This is a headless Flint server (<code>flint serve</code>). It does not host the phone app or pairing. Open this server's address in the phone's browser instead, or pair the phone with a computer running the Flint desktop app (Settings, Remote access).</p><p><a href=\"/\">Open this server</a></p></body>";

const LOGIN_HTML: &str = include_str!("login.html");

/// The sign-in page, with a notice when the last attempt failed. The notice text
/// is chosen here from a short code, never taken from the request.
fn login_page(error: Option<&str>) -> String {
    let notice = match error {
        Some("invalid") => "That credential is not right. Check it and try again.",
        Some("format") => "The credential is 64 characters of 0-9 and a-f.",
        Some("rate") => "Too many attempts. Wait a few minutes and try again.",
        Some("server") => "The server could not start a session. Try again.",
        _ => "",
    };
    let html = if notice.is_empty() {
        String::new()
    } else {
        format!(r#"<p class="notice" role="alert">{notice}</p>"#)
    };
    LOGIN_HTML.replace("{{NOTICE}}", &html)
}

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
    if let Some(run) = control::running(&options.data_folder) {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!(
                "a Flint server is already running on {} (pid {}); stop it with `flint stop`",
                run.listen, run.pid
            ),
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
    // The server's own address as an IP literal, which `flint stop` and the
    // background starter use to reach it. A name an attacker controls can never
    // be this, so it does not weaken the check against DNS rebinding.
    hosts.insert(listener.local_addr()?.to_string());
    let bus = events::Bus::new();
    let agent = agent::Agent::open_with(&options.data_folder, &options.agent_roots, options.agent_run)
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?
        .map(|agent| agent.with_runner(options.agent_runner.clone(), bus.clone()));
    let (auth, bootstrap) = AuthStore::open(options.auth_file)?;
    let settings_store = settings::Store::new(&options.data_folder);
    // Agent runs on this server use the providers its browser client added.
    crate::core::cli::providers::use_server_settings(settings_store.file().to_path_buf());
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let shutdown_token = control::new_token();
    let data_folder_for_run = options.data_folder.clone();
    let state = Arc::new(State {
        auth: Mutex::new(auth),
        assets: options.assets,
        data_folder: options.data_folder,
        hosts,
        public_host: options.public_host.map(|host| host.to_ascii_lowercase()),
        limiter: LoginLimiter::new(),
        mcp: mcp::Host::new(options.allow_mcp_stdio),
        agent,
        allowed_origins: options.allowed_origins.iter().map(|o| o.to_ascii_lowercase()).collect(),
        engine: engine::Supervisor::new(options.llama_worker.clone(), bus.clone()),
        events: bus,
        settings: settings_store,
        shutdown: shutdown.clone(),
        shutdown_token: shutdown_token.clone(),
        trust_proxy: options.trust_proxy,
    });
    // Campaigns the records say this server drives continue on their own,
    // with no client connected (P3 of the server runner).
    if let Some(agent) = &state.agent {
        agent.start_driver();
    }
    eprintln!(
        "Flint web server listening on http://{}",
        listener.local_addr()?
    );
    if !loopback {
        eprintln!(
            "Warning: listening beyond loopback. Sessions travel in the clear unless a TLS proxy fronts this server."
        );
    }
    control::write_run_file(
        &data_folder_for_run,
        &control::RunFile {
            pid: std::process::id(),
            listen: listener.local_addr()?,
            shutdown_token,
        },
    )?;
    if let Some(credential) = bootstrap {
        match &options.credential_file {
            // Started in the background: the starter shows it once and removes
            // the file, so it never lands in the log.
            Some(path) => {
                let mut file = control::create_private(path, false)?;
                io::Write::write_all(&mut file, credential.as_bytes())?;
                eprintln!("First-run administrator credential written for the starter; it is shown only once.");
            }
            None => {
                eprintln!("First-run administrator credential: {credential}");
                eprintln!("Store this credential securely; it is shown only once.");
            }
        }
    }
    uploads::sweep(&data_folder_for_run);
    // At most this many connections at once, so idle sockets cannot use up the
    // process's file descriptors and take the server down with them.
    let connections = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (socket, peer) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                // A failed accept (too many open files, a reset before the
                // handshake) is that connection's problem, not the server's.
                Err(error) => {
                    eprintln!("accept failed: {error}");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
            },
            _ = tokio::signal::ctrl_c() => {
                engine::stop(&state.engine, false).await;
                break;
            }
            _ = shutdown.notified() => {
                engine::stop(&state.engine, false).await;
                break;
            }
        };
        if loopback && !peer.ip().is_loopback() {
            continue;
        }
        let Ok(permit) = connections.clone().try_acquire_owned() else {
            continue; // dropped: the server is at its connection limit
        };
        let state = state.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let io = TokioIo::new(socket);
            let service = service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, std::convert::Infallible>(route(state, req, peer.ip()).await) }
            });
            // The header timeout needs a timer. Without it a client that opens
            // a socket and says nothing would hold it for ever.
            let _ = http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(std::time::Duration::from_secs(15))
                .serve_connection(io, service)
                .await;
        });
    }
    control::remove_run_file(&data_folder_for_run, std::process::id());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body that never delivers a byte, like a client that trickles.
    struct Stalled;

    impl hyper::body::Body for Stalled {
        type Data = Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
            std::task::Poll::Pending
        }
    }

    #[tokio::test]
    async fn login_body_trickle_times_out() {
        let result = collect_limited(Stalled, MAX_LOGIN_BODY, std::time::Duration::from_millis(50)).await;
        assert_eq!(result, Err(StatusCode::REQUEST_TIMEOUT));
    }

    #[tokio::test]
    async fn collect_limited_enforces_size() {
        let deadline = std::time::Duration::from_secs(5);
        let ok = collect_limited(Full::new(Bytes::from_static(b"abcd")), 4, deadline).await;
        assert_eq!(ok, Ok(Bytes::from_static(b"abcd")));
        let big = collect_limited(Full::new(Bytes::from_static(b"abcde")), 4, deadline).await;
        assert_eq!(big, Err(StatusCode::PAYLOAD_TOO_LARGE));
    }

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
            limiter: LoginLimiter::new(),
            mcp: mcp::Host::new(false),
            agent: None,
            allowed_origins: HashSet::new(),
            engine: engine::Supervisor::new(None, events::Bus::new()),
            settings: settings::Store::new(dir.path()),
            events: events::Bus::new(),
            shutdown: Arc::new(tokio::sync::Notify::new()),
            shutdown_token: String::new(),
            trust_proxy: false,
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
            trust_proxy: false,
            agent_roots: Vec::new(),
            agent_run: false,
            agent_runner: Default::default(),
            allowed_hosts: Vec::new(),
            allowed_origins: Vec::new(),
            llama_worker: None,
            credential_file: None,
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
            trust_proxy: false,
            agent_roots: Vec::new(),
            agent_run: false,
            agent_runner: Default::default(),
            allowed_hosts: hosts.into_iter().map(String::from).collect(),
            allowed_origins: origins.into_iter().map(String::from).collect(),
            llama_worker: None,
            credential_file: None,
        };
        let none = serve(options(vec![], vec![])).await.unwrap_err();
        assert!(none.to_string().contains("--allowed-host"));
        let wildcard = serve(options(vec!["*"], vec![])).await.unwrap_err();
        assert!(wildcard.to_string().contains("--allowed-host"));
        let origin = serve(options(vec!["phone.example"], vec!["*"])).await.unwrap_err();
        assert!(origin.to_string().contains("--allowed-origin"));
    }

    #[test]
    fn the_phone_client_is_not_served_and_says_why() {
        for path in ["/m", "/m/", "/m/index.html", "/remote/v1/rpc", "/remote/v1/events"] {
            let resp = phone_client_page(path).unwrap_or_else(|| panic!("{path} must be answered"));
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{path}");
        }
        for path in ["/", "/mcp", "/models", "/api/v1/rpc/x", "/remote-x"] {
            assert!(phone_client_page(path).is_none(), "{path}");
        }
        assert!(PHONE_NOT_HERE_HTML.contains("needs the Flint desktop app"));
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
            limiter: LoginLimiter::new(),
            mcp: mcp::Host::new(false),
            agent: None,
            allowed_origins: HashSet::from(["http://tauri.localhost".to_string()]),
            engine: engine::Supervisor::new(None, events::Bus::new()),
            settings: settings::Store::new(dir.path()),
            events: events::Bus::new(),
            shutdown: Arc::new(tokio::sync::Notify::new()),
            shutdown_token: String::new(),
            trust_proxy: false,
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
    fn session_cookie_is_secure_for_https_origins_on_known_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let (auth, _) = AuthStore::open(dir.path().join("auth.json")).unwrap();
        let state = State {
            auth: Mutex::new(auth),
            assets: dir.path().to_path_buf(),
            data_folder: dir.path().to_path_buf(),
            hosts: HashSet::from(["box.ts.net:8443".to_string(), "localhost:1340".to_string()]),
            public_host: Some("box.ts.net".to_string()),
            limiter: LoginLimiter::new(),
            mcp: mcp::Host::new(false),
            agent: None,
            allowed_origins: HashSet::new(),
            engine: engine::Supervisor::new(None, events::Bus::new()),
            settings: settings::Store::new(dir.path()),
            events: events::Bus::new(),
            shutdown: Arc::new(tokio::sync::Notify::new()),
            shutdown_token: String::new(),
            trust_proxy: false,
        };
        let mut headers = hyper::HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("box.ts.net:8443"));
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://box.ts.net:8443"));
        assert!(cookie_secure(&state, &headers));
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://localhost:1340"));
        headers.insert(header::HOST, HeaderValue::from_static("localhost:1340"));
        assert!(!cookie_secure(&state, &headers));
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://evil.example"));
        assert!(!cookie_secure(&state, &headers));
        headers.insert(header::HOST, HeaderValue::from_static("box.ts.net"));
        headers.remove(header::ORIGIN);
        assert!(cookie_secure(&state, &headers));
    }

    #[test]
    fn the_login_page_shows_a_notice_chosen_here_never_one_from_the_request() {
        assert!(!login_page(None).contains("class=\"notice\""));
        let shown = login_page(Some("invalid"));
        assert!(shown.contains(r#"<p class="notice" role="alert">That credential is not right."#));
        assert!(login_page(Some("rate")).contains("Too many attempts"));
        let hostile = login_page(Some("<script>alert(1)</script>"));
        assert!(!hostile.contains("<script>alert"));
        assert!(!hostile.contains("class=\"notice\""));
        assert!(login_page(None).contains("action=\"/api/v1/session\""));
        assert!(!login_page(None).contains("{{"));
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
