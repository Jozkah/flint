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
use super::mcp;
use super::provider;
use super::resources;
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
}

struct State {
    auth: Mutex<AuthStore>,
    assets: PathBuf,
    data_folder: PathBuf,
    hosts: HashSet<String>,
    public_host: Option<String>,
    login_failures: Mutex<VecDeque<Instant>>,
    mcp: mcp::Host,
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
        (Method::GET, "/api/v1/hardware/info") => {
            blocking(|| Ok(tauri_plugin_hardware::get_system_info())).await
        }
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

async fn route(state: Arc<State>, req: Request<Incoming>) -> Resp {
    if !host_allowed(&state, req.headers()) {
        return text(StatusCode::MISDIRECTED_REQUEST, "Unknown host");
    }
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    if path == "/healthz" && method == Method::GET {
        return text(StatusCode::OK, "ok");
    }
    if method != Method::GET && method != Method::HEAD && !same_origin(&state, req.headers()) {
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
    let session = session_cookie(req.headers());
    let authorized = session.is_some_and(|token| state.auth.lock().unwrap().authorize(token));
    if !authorized {
        if method == Method::GET || method == Method::HEAD {
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
    if let Some(rest) = path.strip_prefix("/api/v1/mcp/") {
        return mcp_route(&state, &method, rest, req).await;
    }
    if path.starts_with("/api/v1/projects")
        || path.starts_with("/api/v1/assistants")
        || path.starts_with("/api/v1/hardware")
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
    if !options.bind.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "headless server must bind loopback; use a private-network HTTPS proxy",
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
    let (auth, bootstrap) = AuthStore::open(options.auth_file)?;
    let state = Arc::new(State {
        auth: Mutex::new(auth),
        assets: options.assets,
        data_folder: options.data_folder,
        hosts,
        public_host: options.public_host.map(|host| host.to_ascii_lowercase()),
        login_failures: Mutex::new(VecDeque::new()),
        mcp: mcp::Host::new(options.allow_mcp_stdio),
    });
    eprintln!(
        "Flint web server listening on http://{}",
        listener.local_addr()?
    );
    if let Some(credential) = bootstrap {
        eprintln!("First-run administrator credential: {credential}");
        eprintln!("Store this credential securely; it is shown only once.");
    }
    loop {
        let (socket, peer) = tokio::select! {
            accepted = listener.accept() => accepted?,
            _ = tokio::signal::ctrl_c() => break,
        };
        if !peer.ip().is_loopback() {
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
    async fn non_loopback_bind_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "ok").unwrap();
        let error = serve(Options {
            bind: "0.0.0.0:0".parse().unwrap(),
            assets: dir.path().to_path_buf(),
            data_folder: dir.path().to_path_buf(),
            auth_file: dir.path().join("auth.json"),
            public_host: None,
            allow_mcp_stdio: false,
        })
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
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
