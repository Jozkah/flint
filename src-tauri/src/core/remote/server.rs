//! The HTTP(S) and WebSocket listener phones talk to.
//!
//! Routes (all JSON unless noted):
//! - `POST   /remote/v1/pair`         `{code, deviceName}` -> `{pollId, confirmNumber}`
//! - `GET    /remote/v1/pair/status`  header `X-Flint-Pairing: <pollId>`
//! - `GET    /remote/v1/me`           the calling device
//! - `DELETE /remote/v1/me`           unpair the calling device
//! - `POST   /remote/v1/rpc`          `{id, method, params}` -> `{id, result}|{id, error}`
//! - `GET    /remote/v1/events`       WebSocket of desktop events
//! - `GET    /m/...`                  the phone app's static files
//!
//! Everything but the two pairing routes and `/m/` needs
//! `Authorization: Bearer <token>`. The WebSocket takes the token in
//! `Sec-WebSocket-Protocol` (`flint-auth.<token>`) or as its first message,
//! never in the URL, where it would end up in logs and history.
//!
//! Browser defences: the `Host` header must name this listener (so a DNS
//! rebinding page cannot reach it under its own name), and a request that
//! carries an `Origin` must come from this listener's own origin. Nothing is
//! served cross-origin, so no CORS headers are ever sent.

use std::collections::HashSet;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame, Role};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use super::auth::Device;
use super::hub::{event_matches, ClaimError, RemoteHub, RpcReject};
use super::static_files;

pub const API_PREFIX: &str = "/remote/v1";
pub const WS_PROTOCOL: &str = "flint-remote.v1";
const WS_AUTH_PREFIX: &str = "flint-auth.";
const MAX_RPC_BODY: usize = 256 * 1024;
const MAX_PAIR_BODY: usize = 4 * 1024;
/// `voice.transcribe` carries a recording (base64 WAV, about 2.5 minutes).
const MAX_VOICE_BODY: usize = 6 * 1024 * 1024;
const VOICE_METHOD: &str = "voice.transcribe";
/// A socket that has not authenticated by then is closed.
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);

type Resp = Response<Full<Bytes>>;

/// What the router needs to know about the listener it serves.
#[derive(Debug, Clone)]
pub struct Listener {
    pub https: bool,
    /// Every `host[:port]` a request may name: the bound IP, the certificate's
    /// DNS name, and `localhost` when bound to loopback.
    pub hosts: HashSet<String>,
}

impl Listener {
    pub fn new(https: bool, addr: SocketAddr, hostname: Option<&str>) -> Self {
        let port = addr.port();
        let mut hosts = HashSet::new();
        hosts.insert(format!("{}:{port}", addr.ip()));
        if let Some(h) = hostname {
            hosts.insert(format!("{}:{port}", h.to_ascii_lowercase()));
        }
        if addr.ip().is_loopback() {
            hosts.insert(format!("localhost:{port}"));
        }
        Self { https, hosts }
    }

    fn host_allowed(&self, host: &str) -> bool {
        self.hosts.contains(&host.to_ascii_lowercase())
    }

    /// `Origin` absent (a native client) or exactly one of our own origins.
    fn origin_allowed(&self, origin: Option<&str>) -> bool {
        let Some(origin) = origin else { return true };
        let scheme = if self.https { "https://" } else { "http://" };
        origin
            .strip_prefix(scheme)
            .is_some_and(|host| self.host_allowed(host))
    }
}

fn with_security_headers(mut resp: Resp) -> Resp {
    let h = resp.headers_mut();
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    resp
}

fn json_resp(status: StatusCode, body: Value) -> Resp {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .expect("static response parts are valid")
}

fn error(status: StatusCode, code: &str, message: &str) -> Resp {
    json_resp(
        status,
        json!({ "error": { "code": code, "message": message } }),
    )
}

pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then_some(token.trim())
}

/// The token a WebSocket offered as a subprotocol, and whether it offered
/// ours.
pub fn ws_protocols(headers: &HeaderMap) -> (Option<String>, bool) {
    let mut token = None;
    let mut ours = false;
    for value in headers.get_all(header::SEC_WEBSOCKET_PROTOCOL) {
        let Ok(value) = value.to_str() else { continue };
        for p in value.split(',').map(str::trim) {
            if p == WS_PROTOCOL {
                ours = true;
            } else if let Some(t) = p.strip_prefix(WS_AUTH_PREFIX) {
                token = Some(t.to_string());
            }
        }
    }
    (token, ours)
}

fn too_large() -> Resp {
    error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "too_large",
        "Request body too large",
    )
}

async fn read_bytes(body: Incoming, limit: usize) -> Result<Bytes, Resp> {
    Ok(Limited::new(body, limit)
        .collect()
        .await
        .map_err(|_| too_large())?
        .to_bytes())
}

fn parse_json<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, Resp> {
    serde_json::from_slice(bytes)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "bad_request", "Malformed JSON"))
}

async fn read_json<T: for<'de> Deserialize<'de>>(body: Incoming, limit: usize) -> Result<T, Resp> {
    parse_json(&read_bytes(body, limit).await?)
}

/// Only `voice.transcribe` may use the larger cap; every other call keeps
/// the usual one.
fn body_fits(bytes: &[u8]) -> bool {
    if bytes.len() <= MAX_RPC_BODY {
        return true;
    }
    #[derive(Deserialize)]
    struct MethodOnly {
        method: String,
    }
    serde_json::from_slice::<MethodOnly>(bytes).is_ok_and(|m| m.method == VOICE_METHOD)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    code: String,
    #[serde(default)]
    device_name: String,
}

#[derive(Deserialize)]
struct RpcBody {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

/// Routes one request. Public for tests.
pub async fn handle(
    hub: Arc<RemoteHub>,
    listener: Arc<Listener>,
    peer: IpAddr,
    req: Request<Incoming>,
) -> Resp {
    with_security_headers(route(hub, listener, peer, req).await)
}

async fn route(
    hub: Arc<RemoteHub>,
    listener: Arc<Listener>,
    peer: IpAddr,
    req: Request<Incoming>,
) -> Resp {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !listener.host_allowed(host) {
        return error(StatusCode::MISDIRECTED_REQUEST, "bad_host", "Unknown host");
    }
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if !listener.origin_allowed(origin) {
        return error(
            StatusCode::FORBIDDEN,
            "cross_origin",
            "Cross-origin requests are not allowed",
        );
    }
    if hub.is_blocked(peer) {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many attempts; try again later",
        );
    }

    let path = req.uri().path().to_string();
    let method = req.method().clone();

    if path == "/" || path == "/m" {
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, "/m/")
            .body(Full::new(Bytes::new()))
            .expect("static response parts are valid");
    }
    if let Some(rel) = path.strip_prefix("/m/") {
        if method != Method::GET && method != Method::HEAD {
            return error(
                StatusCode::METHOD_NOT_ALLOWED,
                "method",
                "Method not allowed",
            );
        }
        return serve_static(&hub, rel).await;
    }
    let Some(api) = path.strip_prefix(API_PREFIX) else {
        return error(StatusCode::NOT_FOUND, "not_found", "Not found");
    };

    match (method, api) {
        (Method::POST, "/pair") => {
            let body: PairBody = match read_json(req.into_body(), MAX_PAIR_BODY).await {
                Ok(b) => b,
                Err(r) => return r,
            };
            match hub.claim_pairing(peer, &body.code, &body.device_name) {
                Ok(c) => json_resp(
                    StatusCode::OK,
                    json!({ "status": "pending", "pollId": c.poll_id, "confirmNumber": c.confirm_number }),
                ),
                Err(ClaimError::RateLimited) => error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limited",
                    "Too many attempts; try again later",
                ),
                Err(ClaimError::InvalidCode) => error(
                    StatusCode::UNAUTHORIZED,
                    "invalid_code",
                    "This pairing code is wrong, expired or already used",
                ),
            }
        }
        (Method::GET, "/pair/status") => {
            let poll = req
                .headers()
                .get("x-flint-pairing")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            let r = hub.poll_pairing(peer, poll);
            json_resp(
                StatusCode::OK,
                serde_json::to_value(&r).unwrap_or(Value::Null),
            )
        }
        (_, "/pair") | (_, "/pair/status") => error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method",
            "Method not allowed",
        ),
        (method, api) => {
            let is_ws = api == "/events" && method == Method::GET && is_upgrade(req.headers());
            if is_ws {
                return upgrade(hub, req);
            }
            let Some(device) = hub.authenticate(bearer(req.headers()), peer) else {
                return error(StatusCode::UNAUTHORIZED, "unauthorized", "Not paired");
            };
            match (method, api) {
                (Method::GET, "/me") => json_resp(
                    StatusCode::OK,
                    json!({ "id": device.id, "name": device.name, "pairedAt": device.paired_at }),
                ),
                (Method::DELETE, "/me") => {
                    hub.revoke(&device.id);
                    json_resp(StatusCode::OK, json!({ "ok": true }))
                }
                (Method::POST, "/rpc") => rpc(&hub, &device, req.into_body()).await,
                (_, "/events") => error(
                    StatusCode::UPGRADE_REQUIRED,
                    "upgrade",
                    "WebSocket required",
                ),
                _ => error(StatusCode::NOT_FOUND, "not_found", "Not found"),
            }
        }
    }
}

async fn rpc(hub: &RemoteHub, device: &Device, body: Incoming) -> Resp {
    let bytes = match read_bytes(body, MAX_VOICE_BODY).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if !body_fits(&bytes) {
        return too_large();
    }
    let body: RpcBody = match parse_json(&bytes) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let id = body.id;
    match hub.rpc(device, &body.method, body.params).await {
        Ok(Ok(result)) => json_resp(StatusCode::OK, json!({ "id": id, "result": result })),
        Ok(Err(e)) => json_resp(StatusCode::OK, json!({ "id": id, "error": e })),
        Err(RpcReject::BadMethod) => {
            error(StatusCode::BAD_REQUEST, "bad_method", "Invalid method name")
        }
        Err(RpcReject::Forbidden(why)) => error(StatusCode::FORBIDDEN, "forbidden", why),
        Err(RpcReject::Unavailable) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "Flint's window is not available",
        ),
        Err(RpcReject::Timeout) => error(
            StatusCode::GATEWAY_TIMEOUT,
            "timeout",
            "Flint did not answer in time",
        ),
    }
}

async fn serve_static(hub: &RemoteHub, rel: &str) -> Resp {
    let placeholder = || {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(
                "content-security-policy",
                "default-src 'none'; style-src 'unsafe-inline'",
            )
            .body(Full::new(Bytes::from_static(
                static_files::PLACEHOLDER_HTML.as_bytes(),
            )))
            .expect("static response parts are valid")
    };
    let Some(root) = hub
        .static_dir
        .as_ref()
        .filter(|d| d.join("index.html").is_file())
    else {
        return match static_files::sanitize(rel) {
            Ok(_) => placeholder(),
            Err(_) => error(StatusCode::FORBIDDEN, "forbidden", "Forbidden"),
        };
    };
    match static_files::resolve(root, rel) {
        Ok(path) => match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let is_index = path.file_name().is_some_and(|n| n == "index.html");
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, static_files::content_type(&path))
                    .header(
                        header::CACHE_CONTROL,
                        if is_index {
                            "no-store"
                        } else {
                            "public, max-age=3600"
                        },
                    )
                    .body(Full::new(Bytes::from(bytes)))
                    .expect("static response parts are valid")
            }
            Err(_) => error(StatusCode::NOT_FOUND, "not_found", "Not found"),
        },
        Err(static_files::StaticError::Forbidden) => {
            error(StatusCode::FORBIDDEN, "forbidden", "Forbidden")
        }
        Err(static_files::StaticError::NotFound) => {
            error(StatusCode::NOT_FOUND, "not_found", "Not found")
        }
    }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

fn upgrade(hub: Arc<RemoteHub>, mut req: Request<Incoming>) -> Resp {
    let Some(key) = req.headers().get(header::SEC_WEBSOCKET_KEY).cloned() else {
        return error(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "Missing WebSocket key",
        );
    };
    let (proto_token, offered_ours) = ws_protocols(req.headers());
    // Header auth is checked before upgrading, so a bad token never gets a
    // socket. Without one, the first message must authenticate.
    let pre_auth = match proto_token {
        Some(t) => {
            let peer = req
                .extensions()
                .get::<PeerIp>()
                .map(|p| p.0)
                .unwrap_or(IpAddr::from([0, 0, 0, 0]));
            match hub.authenticate(Some(&t), peer) {
                Some(d) => Some(d),
                None => return error(StatusCode::UNAUTHORIZED, "unauthorized", "Not paired"),
            }
        }
        None => None,
    };
    let peer = req.extensions().get::<PeerIp>().map(|p| p.0);
    let stop = req.extensions().get::<StopSignal>().map(|s| s.0.clone());
    let upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        match upgrade.await {
            Ok(upgraded) => {
                let ws =
                    WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None)
                        .await;
                run_socket(hub, ws, pre_auth, peer, stop).await;
            }
            Err(e) => log::debug!("remote: websocket upgrade failed: {e}"),
        }
    });
    let mut resp = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(
            header::SEC_WEBSOCKET_ACCEPT,
            derive_accept_key(key.as_bytes()),
        );
    if offered_ours {
        resp = resp.header(header::SEC_WEBSOCKET_PROTOCOL, WS_PROTOCOL);
    }
    resp.body(Full::new(Bytes::new()))
        .expect("static response parts are valid")
}

#[derive(Clone, Copy)]
struct PeerIp(IpAddr);

/// The listener's stop signal, so sockets end with it.
#[derive(Clone)]
struct StopSignal(watch::Receiver<bool>);

async fn stopped(stop: &mut Option<watch::Receiver<bool>>) {
    match stop {
        Some(rx) => {
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await
            }
        }
        None => std::future::pending::<()>().await,
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Auth { token: String },
    Subscribe { topics: Vec<String> },
    Unsubscribe { topics: Vec<String> },
    Ping,
}

async fn run_socket<S>(
    hub: Arc<RemoteHub>,
    mut ws: WebSocketStream<S>,
    pre_auth: Option<Device>,
    peer: Option<IpAddr>,
    mut stop: Option<watch::Receiver<bool>>,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let peer = peer.unwrap_or(IpAddr::from([0, 0, 0, 0]));
    let device = match pre_auth {
        Some(d) => d,
        None => {
            let first = tokio::time::timeout(WS_AUTH_TIMEOUT, ws.next()).await;
            let token = match first {
                Ok(Some(Ok(Message::Text(t)))) => match serde_json::from_str::<ClientMessage>(&t) {
                    Ok(ClientMessage::Auth { token }) => Some(token),
                    _ => None,
                },
                _ => None,
            };
            match token.and_then(|t| hub.authenticate(Some(&t), peer)) {
                Some(d) => d,
                None => {
                    let _ = ws
                        .close(Some(CloseFrame {
                            code: CloseCode::Policy,
                            reason: "unauthorized".into(),
                        }))
                        .await;
                    return;
                }
            }
        }
    };

    hub.socket_opened(&device.id);
    let mut events = hub.subscribe_events();
    let mut revoked = hub.subscribe_revocations();
    let mut topics: HashSet<String> = HashSet::new();
    let ready = json!({ "type": "ready", "deviceId": device.id }).to_string();
    let mut alive = ws.send(Message::Text(ready.into())).await.is_ok();

    while alive {
        tokio::select! {
            ev = events.recv() => match ev {
                Ok(ev) if event_matches(&ev, &topics) => {
                    let msg = json!({ "type": "event", "topic": ev.topic, "event": ev.event }).to_string();
                    alive = ws.send(Message::Text(msg.into())).await.is_ok();
                }
                Ok(_) => {}
                // A slow phone missed events: say so, so it can refetch.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    let msg = json!({ "type": "lagged", "missed": n }).to_string();
                    alive = ws.send(Message::Text(msg.into())).await.is_ok();
                }
                Err(_) => alive = false,
            },
            _ = stopped(&mut stop) => {
                let _ = ws.close(Some(CloseFrame { code: CloseCode::Away, reason: "stopped".into() })).await;
                alive = false;
            },
            id = revoked.recv() => {
                if matches!(&id, Ok(id) if *id == device.id) {
                    let _ = ws.close(Some(CloseFrame { code: CloseCode::Policy, reason: "unpaired".into() })).await;
                    alive = false;
                }
            },
            msg = ws.next() => match msg {
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<ClientMessage>(&t) {
                    Ok(ClientMessage::Subscribe { topics: t }) => topics.extend(t.into_iter().take(64)),
                    Ok(ClientMessage::Unsubscribe { topics: t }) => t.iter().for_each(|x| { topics.remove(x); }),
                    Ok(ClientMessage::Ping) => {
                        alive = ws.send(Message::Text(json!({ "type": "pong" }).to_string().into())).await.is_ok();
                    }
                    _ => {}
                },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => alive = false,
                Some(Ok(_)) => {}
            },
        }
    }
    hub.socket_closed(&device.id);
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

pub struct RunningServer {
    pub addr: SocketAddr,
    shutdown: watch::Sender<bool>,
}

impl RunningServer {
    pub fn stop(self) {
        let _ = self.shutdown.send(true);
    }
}

async fn serve_conn<S>(
    stream: S,
    hub: Arc<RemoteHub>,
    listener: Arc<Listener>,
    peer: IpAddr,
    mut stop: watch::Receiver<bool>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let signal = StopSignal(stop.clone());
    let service = service_fn(move |mut req: Request<Incoming>| {
        let hub = hub.clone();
        let listener = listener.clone();
        req.extensions_mut().insert(PeerIp(peer));
        req.extensions_mut().insert(signal.clone());
        async move { Ok::<_, Infallible>(handle(hub, listener, peer, req).await) }
    });
    let conn = http1::Builder::new()
        // The header timeout needs a timer; without one hyper panics on the
        // first connection. It keeps a stalled client from holding a socket.
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(Duration::from_secs(15))
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades();
    tokio::pin!(conn);
    tokio::select! {
        _ = conn.as_mut() => {}
        _ = stop.changed() => conn.as_mut().graceful_shutdown(),
    }
}

/// Binds `addr` and serves until stopped. Binding happens here, so a port in
/// use is reported to the caller rather than lost in a task.
pub async fn start(
    hub: Arc<RemoteHub>,
    addr: SocketAddr,
    tls: Option<Arc<rustls::ServerConfig>>,
    hostname: Option<String>,
) -> std::io::Result<RunningServer> {
    let tcp = TcpListener::bind(addr).await?;
    let bound = tcp.local_addr()?;
    let listener = Arc::new(Listener::new(tls.is_some(), bound, hostname.as_deref()));
    let https = tls.is_some();
    let acceptor = tls.map(TlsAcceptor::from);
    let (tx, rx) = watch::channel(false);
    let mut stop = rx.clone();
    tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                a = tcp.accept() => a,
                _ = stop.changed() => break,
            };
            let Ok((stream, peer)) = accepted else {
                continue;
            };
            let peer_ip = peer.ip();
            if hub.is_blocked(peer_ip) {
                continue; // dropped: this IP failed authentication too often
            }
            let hub = hub.clone();
            let listener = listener.clone();
            let acceptor = acceptor.clone();
            let conn_stop = rx.clone();
            tokio::spawn(async move {
                match acceptor {
                    Some(acceptor) => {
                        match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream))
                            .await
                        {
                            Ok(Ok(tls)) => serve_conn(tls, hub, listener, peer_ip, conn_stop).await,
                            _ => log::debug!("remote: TLS handshake from {peer_ip} failed"),
                        }
                    }
                    None => serve_conn(stream, hub, listener, peer_ip, conn_stop).await,
                }
            });
        }
        log::info!("remote: listener on {bound} stopped");
    });
    log::info!(
        "remote: listening on {bound} ({})",
        if https { "https" } else { "http" }
    );
    Ok(RunningServer {
        addr: bound,
        shutdown: tx,
    })
}

#[cfg(test)]
mod body_cap_tests {
    use super::*;

    #[test]
    fn only_voice_transcribe_may_exceed_the_usual_cap() {
        let pad = "a".repeat(MAX_RPC_BODY);
        let voice = format!(r#"{{"id":"1","method":"voice.transcribe","params":{{"audio":"{pad}"}}}}"#);
        let other = format!(r#"{{"id":"1","method":"chat.send","params":{{"text":"{pad}"}}}}"#);
        assert!(body_fits(voice.as_bytes()));
        assert!(!body_fits(other.as_bytes()));
        assert!(body_fits(br#"{"id":"1","method":"chat.send","params":{}}"#));
    }
}
