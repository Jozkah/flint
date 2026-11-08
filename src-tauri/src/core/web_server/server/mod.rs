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

mod mcp_api;
mod resource_api;
mod rpc_api;
use mcp_api::mcp_route;
use resource_api::resource_route;
use rpc_api::rpc_route;

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

#[cfg(unix)]
type TermSignal = tokio::signal::unix::Signal;
#[cfg(not(unix))]
type TermSignal = std::convert::Infallible;

/// A SIGTERM listener, registered once so a signal between two loop turns is
/// not lost to the default action. `None` off Unix.
fn term_signal() -> Option<TermSignal> {
    #[cfg(unix)]
    {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok()
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// Resolves when SIGTERM arrives; never on a platform without it.
#[cfg_attr(not(unix), allow(unused_variables))]
async fn terminated(signal: &mut Option<TermSignal>) {
    #[cfg(unix)]
    if let Some(signal) = signal {
        signal.recv().await;
        return;
    }
    std::future::pending::<()>().await
}

/// A command failure as a reply: a plain-text message stays text, anything
/// else is sent as JSON.
fn failure_reply(failure: super::agent::Fail) -> Resp {
    let status = StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_REQUEST);
    match failure.body {
        serde_json::Value::String(message) => reply(status, "text/plain; charset=utf-8", message),
        other => reply(
            status,
            "application/json",
            serde_json::to_vec(&other).unwrap_or_default(),
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

/// The most request-body bytes all connections together may hold in memory
/// at once. Each body is buffered whole, and one client could otherwise open
/// many connections each sending a 64 MB JSON body or a 100 MB upload.
const BODY_BUDGET_BYTES: usize = 256 * 1024 * 1024;

/// Bodies this small skip the budget: sign-in and ordinary JSON must not
/// queue behind someone's uploads.
const UNBUDGETED_BODY_BYTES: usize = 64 * 1024;

fn body_budget() -> &'static Arc<tokio::sync::Semaphore> {
    static BUDGET: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    BUDGET.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(BODY_BUDGET_BYTES)))
}

/// A collected body and its share of the global body budget, released when
/// this is dropped -- after the caller is done with the bytes, not when
/// collection ends.
#[derive(Debug)]
pub(super) struct BudgetedBody {
    bytes: Bytes,
    _permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

impl std::ops::Deref for BudgetedBody {
    type Target = Bytes;
    fn deref(&self) -> &Bytes {
        &self.bytes
    }
}

/// The bytes a body may hold: its declared length when it has one (hyper
/// refuses a body that runs past it), else the route's cap.
fn body_reservation<B: hyper::body::Body>(body: &B, max: usize) -> usize {
    body.size_hint().upper().and_then(|n| usize::try_from(n).ok()).unwrap_or(max).min(max)
}

/// Wait for `bytes` of the global body budget, up to `deadline`.
async fn reserve_body_budget(
    budget: &Arc<tokio::sync::Semaphore>,
    bytes: usize,
    deadline: std::time::Duration,
) -> Result<Option<tokio::sync::OwnedSemaphorePermit>, StatusCode> {
    if bytes <= UNBUDGETED_BODY_BYTES {
        return Ok(None);
    }
    let permits = u32::try_from(bytes).map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    match tokio::time::timeout(deadline, Arc::clone(budget).acquire_many_owned(permits)).await {
        Ok(Ok(permit)) => Ok(Some(permit)),
        _ => Err(StatusCode::SERVICE_UNAVAILABLE),
    }
}

/// The whole body, or the status to refuse with: 413 over `max` bytes, 408 when
/// the client has not finished sending within `deadline` (a trickling client
/// would otherwise hold the connection and its buffer open), 503 when the
/// global body budget stays full for that long.
async fn collect_limited<B>(
    body: B,
    max: usize,
    deadline: std::time::Duration,
) -> Result<BudgetedBody, StatusCode>
where
    B: hyper::body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    collect_budgeted(body, max, deadline, body_budget()).await
}

async fn collect_budgeted<B>(
    body: B,
    max: usize,
    deadline: std::time::Duration,
    budget: &Arc<tokio::sync::Semaphore>,
) -> Result<BudgetedBody, StatusCode>
where
    B: hyper::body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let permit = reserve_body_budget(budget, body_reservation(&body, max), deadline).await?;
    match tokio::time::timeout(deadline, Limited::new(body, max).collect()).await {
        Ok(Ok(collected)) => Ok(BudgetedBody { bytes: collected.to_bytes(), _permit: permit }),
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

/// How a request is authenticated, decided by where it sits in `route_inner`.
///
/// The order below is the security model, so it is spelled out once:
/// 1. `Public` routes answer before any session is looked at: the health
///    probe, the token-guarded shutdown, token and credential sign-in, and the
///    sign-in page itself. Each has its own guard (a shutdown token, the
///    credential, the limiter).
/// 2. Everything else is `Session`: a valid bearer token or session cookie, or
///    a redirect to `/login` (GET) / a 401.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Auth {
    Public,
    Session,
}

/// The routes served before the session gate. Anything not listed here is
/// behind it, including every route added later.
fn route_auth(method: &Method, path: &str) -> Auth {
    let public = ((path == "/healthz" || path == "/readyz") && method == Method::GET)
        || (path == "/api/v1/shutdown" && method == Method::POST)
        || (path == "/api/v1/token" && method == Method::POST)
        || (path == "/login" && method == Method::GET)
        || (path == "/api/v1/session" && method == Method::POST);
    if public {
        Auth::Public
    } else {
        Auth::Session
    }
}

async fn route_inner(state: Arc<State>, req: Request<Incoming>, client: std::net::IpAddr) -> Resp {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    if path == "/healthz" && method == Method::GET {
        return healthz();
    }
    if path == "/readyz" && method == Method::GET {
        return readyz(&state);
    }
    if path == "/api/v1/shutdown" && method == Method::POST {
        return shutdown_route(&state, &req);
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
        return login_form(&req);
    }
    if sign_in {
        return session_sign_in(&state, req, client).await;
    }
    debug_assert_eq!(route_auth(&method, &path), Auth::Session);

    // An Authorization header decides on its own: a bad token is never
    // rescued by a cookie that happens to ride along.
    let presented_bearer = req.headers().contains_key(header::AUTHORIZATION);
    let session: Option<String> = if presented_bearer {
        bearer_token(req.headers())
    } else {
        session_cookie(req.headers())
    }
    .map(str::to_owned);
    let authorized = session
        .as_deref()
        .is_some_and(|token| state.auth.lock().unwrap_or_else(|p| p.into_inner()).authorize(token));
    if !authorized {
        return unauthenticated(presented_bearer, &method);
    }
    if path == "/api/v1/sessions" && method == Method::DELETE {
        return end_all_sessions(&state);
    }
    if path == "/api/v1/session" {
        if let Some(response) = session_route(&state, &method, session.as_deref()) {
            return response;
        }
    }
    let req = match thread_write_routes(&state, &method, &path, req).await {
        Ok(response) => return response,
        Err(req) => req,
    };
    if method == Method::GET && path.starts_with("/api/v1/agent/sessions/") && path.ends_with("/events") {
        return agent_events(&state, &req, &path).await;
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
    let req = match upload_routes(&state, &method, &path, req).await {
        Ok(response) => return response,
        Err(req) => req,
    };
    if let Some(command) = path.strip_prefix("/api/v1/rpc/") {
        return rpc_entry(&state, &method, command, session.as_deref(), client, req).await;
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
    if let Some(response) = thread_read_routes(&state, &method, &path).await {
        return response;
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
    serve_asset(&state, &method, &path).await
}

/// Readiness for supervisors: 200 `ready` while the data folder is there to
/// serve from, 503 `not ready` otherwise. No versions, paths or counts.
fn readyz(state: &State) -> Resp {
    if state.data_folder.is_dir() {
        text(StatusCode::OK, "ready")
    } else {
        text(StatusCode::SERVICE_UNAVAILABLE, "not ready")
    }
}

fn healthz() -> Resp {
    // The marker lets `flint stop` tell this server from any other
    // program that answers `/healthz` on a reused port.
    let mut resp = text(StatusCode::OK, "ok");
    resp.headers_mut().insert(
        header::HeaderName::from_static(control::SERVER_MARKER_HEADER),
        HeaderValue::from_static("1"),
    );
    resp
}

fn shutdown_route(state: &State, req: &Request<Incoming>) -> Resp {
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
    no_content()
}

fn login_form(req: &Request<Incoming>) -> Resp {
    let error = req
        .uri()
        .query()
        .and_then(|q| form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "error"))
        .map(|(_, v)| v.into_owned());
    reply(
        StatusCode::OK,
        "text/html; charset=utf-8",
        login_page(error.as_deref()),
    )
}

async fn session_sign_in(state: &State, req: Request<Incoming>, client: std::net::IpAddr) -> Resp {
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
    let secure = cookie_secure(state, req.headers());
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
    match result {
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
    }
}

/// The answer for a request with no valid session: a browser page load goes to
/// the sign-in page, anything else gets a 401.
fn unauthenticated(presented_bearer: bool, method: &Method) -> Resp {
    if !presented_bearer && (*method == Method::GET || *method == Method::HEAD) {
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
    text(StatusCode::UNAUTHORIZED, "Sign in required")
}

fn end_all_sessions(state: &State) -> Resp {
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
    response
}

/// `GET` and `DELETE` on the current session; `None` for any other method.
fn session_route(state: &State, method: &Method, session: Option<&str>) -> Option<Resp> {
    if *method == Method::GET {
        return Some(reply(
            StatusCode::OK,
            "application/json",
            r#"{"authenticated":true}"#,
        ));
    }
    if *method == Method::DELETE {
        if state
            .auth
            .lock()
            .unwrap()
            .sign_out(session.unwrap())
            .is_err()
        {
            return Some(text(StatusCode::INTERNAL_SERVER_ERROR, "Could not end session"));
        }
        let mut response = reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new());
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_static(
                "flint_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            ),
        );
        return Some(response);
    }
    None
}

/// Thread and message writes. `Err(req)` hands the request back when the path
/// is not one of them, so the dispatcher can keep going.
async fn thread_write_routes(
    state: &State,
    method: &Method,
    path: &str,
    req: Request<Incoming>,
) -> Result<Resp, Request<Incoming>> {
    if *method == Method::POST && path == "/api/v1/threads" {
        let thread = match read_json(req).await {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let root = state.data_folder.clone();
        return Ok(match tokio::task::spawn_blocking(move || data::create_thread(&root, thread)).await {
            Ok(Ok(thread)) => json_created(&thread),
            _ => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not create thread"),
        });
    }
    let Some(rest) = path.strip_prefix("/api/v1/threads/") else {
        return Err(req);
    };
    let parts: Vec<_> = rest.split('/').collect();
    if parts.iter().any(|part| crate::core::threads::utils::validate_thread_id(part).is_err()) {
        return Ok(text(StatusCode::BAD_REQUEST, "Invalid id"));
    }
    match (method.clone(), parts.as_slice()) {
        (Method::PUT, [id]) => {
            let thread = match read_json(req).await {
                Ok(value) => value,
                Err(response) => return Ok(response),
            };
            if thread.get("id").and_then(serde_json::Value::as_str) != Some(*id) {
                return Ok(text(StatusCode::BAD_REQUEST, "Thread id does not match URL"));
            }
            let root = state.data_folder.clone();
            let id = (*id).to_owned();
            Ok(match data::update_thread(&root, &id, thread).await {
                Ok(()) => reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new()),
                Err(_) => text(StatusCode::NOT_FOUND, "Thread not found"),
            })
        }
        (Method::DELETE, [id]) => {
            let permanent = req.uri().query() == Some("permanent=true");
            Ok(match data::delete_thread(&state.data_folder, id, permanent).await {
                Ok(()) => reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new()),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete thread"),
            })
        }
        (Method::POST, [id, "messages"]) => {
            let message = match read_json_max(req, MAX_LARGE_JSON_BODY).await {
                Ok(value) => value,
                Err(response) => return Ok(response),
            };
            if message.get("thread_id").and_then(serde_json::Value::as_str) != Some(*id) {
                return Ok(text(StatusCode::BAD_REQUEST, "Message thread id does not match URL"));
            }
            Ok(match data::create_message(&state.data_folder, id, message).await {
                Ok(message) => json_created(&message),
                Err(_) => text(StatusCode::NOT_FOUND, "Thread not found"),
            })
        }
        (Method::PUT, [id, "messages", message_id]) => {
            let message = match read_json_max(req, MAX_LARGE_JSON_BODY).await {
                Ok(value) => value,
                Err(response) => return Ok(response),
            };
            if message.get("thread_id").and_then(serde_json::Value::as_str) != Some(*id)
                || message.get("id").and_then(serde_json::Value::as_str) != Some(*message_id)
            {
                return Ok(text(StatusCode::BAD_REQUEST, "Message id does not match URL"));
            }
            Ok(match data::update_message(&state.data_folder, id, message_id, message).await {
                Ok(message) => json(&message),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not update message"),
            })
        }
        (Method::DELETE, [id, "messages", message_id]) => {
            Ok(match data::delete_message(&state.data_folder, id, message_id).await {
                Ok(()) => reply(StatusCode::NO_CONTENT, "text/plain", Bytes::new()),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete message"),
            })
        }
        _ => Err(req),
    }
}

async fn agent_events(state: &State, req: &Request<Incoming>, path: &str) -> Resp {
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
    match tokio::task::spawn_blocking(move || agent.replay(&id, after)).await {
        Ok(Ok(body)) => reply(StatusCode::OK, "text/event-stream", body),
        Ok(Err(failure)) => {
            let status = StatusCode::from_u16(failure.status).unwrap_or(StatusCode::BAD_REQUEST);
            reply(status, "text/plain; charset=utf-8", failure.body.as_str().unwrap_or("Request failed").to_owned())
        }
        Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Request failed"),
    }
}

/// Upload, parse and delete. `Err(req)` hands the request back when the path
/// is not an upload route.
async fn upload_routes(
    state: &State,
    method: &Method,
    path: &str,
    req: Request<Incoming>,
) -> Result<Resp, Request<Incoming>> {
    if path == "/api/v1/uploads" && *method == Method::POST {
        let name = query_param(req.uri().query(), "name").unwrap_or_default();
        let body = match collect_limited(req.into_body(), uploads::MAX_UPLOAD_BYTES, UPLOAD_BODY_DEADLINE).await {
            Ok(body) => body,
            Err(status) => return Ok(text(status, "File too large or too slow, or the server is busy")),
        };
        let root = state.data_folder.clone();
        return Ok(match tokio::task::spawn_blocking(move || uploads::store(&root, &name, &body)).await {
            Ok(Ok(stored)) => json_created(&stored),
            Ok(Err(uploads::StoreError::OverQuota)) => {
                text(StatusCode::INSUFFICIENT_STORAGE, "Upload storage is full")
            }
            _ => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not store upload"),
        });
    }
    if path == "/api/v1/uploads/parse" && *method == Method::POST {
        let body = match read_json(req).await {
            Ok(body) => body,
            Err(response) => return Ok(response),
        };
        let (Some(file), kind) = (str_field(&body, "path"), str_field(&body, "type").unwrap_or("")) else {
            return Ok(text(StatusCode::BAD_REQUEST, "path is required"));
        };
        let (root, file, kind) = (state.data_folder.clone(), file.to_owned(), kind.to_owned());
        return Ok(match tokio::task::spawn_blocking(move || uploads::parse(&root, &file, &kind)).await {
            Ok(Ok(parsed)) => json(&serde_json::json!({ "text": parsed })),
            Ok(Err(message)) => reply(StatusCode::UNPROCESSABLE_ENTITY, "text/plain; charset=utf-8", message),
            Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Parser failed"),
        });
    }
    if let Some(id) = path.strip_prefix("/api/v1/uploads/") {
        if *method == Method::DELETE {
            let (root, id) = (state.data_folder.clone(), id.to_owned());
            return Ok(match tokio::task::spawn_blocking(move || uploads::delete(&root, &id)).await {
                Ok(Ok(())) => no_content(),
                Ok(Err(_)) => text(StatusCode::BAD_REQUEST, "Invalid upload id"),
                Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not delete upload"),
            });
        }
    }
    Err(req)
}

async fn rpc_entry(
    state: &State,
    method: &Method,
    command: &str,
    session: Option<&str>,
    client: std::net::IpAddr,
    req: Request<Incoming>,
) -> Resp {
    if *method != Method::POST {
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
    rpc_route(state, &command, args, &caller).await
}

/// `GET` of the thread list, one thread, or its messages; `None` for anything
/// else.
async fn thread_read_routes(state: &State, method: &Method, path: &str) -> Option<Resp> {
    if *method == Method::GET && path == "/api/v1/threads" {
        let root = state.data_folder.clone();
        return Some(match tokio::task::spawn_blocking(move || data::threads(&root)).await {
            Ok(Ok(threads)) => json(&threads),
            _ => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not list threads"),
        });
    }
    if *method == Method::GET {
        if let Some(rest) = path.strip_prefix("/api/v1/threads/") {
            let (id, want_messages) = match rest.split_once('/') {
                Some((id, "messages")) => (id, true),
                None => (rest, false),
                _ => return Some(text(StatusCode::NOT_FOUND, "Unknown API route")),
            };
            if crate::core::threads::utils::validate_thread_id(id).is_err() {
                return Some(text(StatusCode::BAD_REQUEST, "Invalid thread id"));
            }
            let id = id.to_owned();
            let root = state.data_folder.clone();
            return Some(
                match tokio::task::spawn_blocking(move || {
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
                },
            );
        }
    }
    None
}

async fn serve_asset(state: &State, method: &Method, path: &str) -> Resp {
    let rel = path.strip_prefix('/').unwrap_or(path);
    let file = match static_files::resolve(&state.assets, rel) {
        Ok(file) => file,
        Err(StaticError::Forbidden) => return text(StatusCode::FORBIDDEN, "Forbidden path"),
        Err(StaticError::NotFound) => return text(StatusCode::NOT_FOUND, "Not found"),
    };
    let content_type = static_files::content_type(&file);
    let body = if *method == Method::HEAD {
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

const LOGIN_HTML: &str = include_str!("../login.html");

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
    let mut term_signal = term_signal();
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
            // `kill` / systemd stop: shut down like Ctrl-C so the engine is
            // stopped and the run file removed.
            _ = terminated(&mut term_signal) => {
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
mod tests;
#[cfg(test)]
mod auth_gate_tests;
