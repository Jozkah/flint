//! Guest links on the web server: `/g/{token}...` (split from `server`).
//!
//! These routes are `Public` -- they answer before any session is looked at,
//! because the visitor has no account. They are the only way in for a guest and
//! they reach exactly one thread. The guard, in this order:
//!
//! 1. only the five shapes below are guest routes; any other path or method
//!    under `/g/` stays behind the session gate;
//! 2. a client that keeps failing is shut out (`limiter`);
//! 3. no `Origin` of another site, and a `POST` must carry this server's own
//!    `Origin` (with the `SameSite=Strict` cookie, that is the CSRF defence;
//!    there is no CORS on these routes, the allowed-origins list is not used);
//! 4. the token and, for everything but the page, the browser-binding cookie are
//!    checked by `guest::store::Store::authorize`. An unknown token, an expired
//!    or stopped share, the feature being off, a deleted thread and the wrong
//!    browser all get the same 404, so nothing can be probed;
//! 5. a body is read only after that, under a tight cap.
//!
//! | route | does |
//! |---|---|
//! | `GET  /g/{token}` | the static page (needs a live token, not the cookie) |
//! | `POST /g/{token}/join` | binds this browser on first call, sets the cookie |
//! | `GET  /g/{token}/snapshot` | recent history of the one thread, projected |
//! | `GET  /g/{token}/events` | server-sent events: the same projection, live |
//! | `POST /g/{token}/message` | queues a message for the owner; runs nothing |

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use sha2::{Digest, Sha256};

use super::*;
use crate::core::guest::store::{self, Access, Attachment, Mode, QueueError, Store};
use crate::core::guest::view;

const PAGE: &str = include_str!("guest_page.html");
/// Two 1 MiB files as base64, the text and the JSON around them.
const MAX_GUEST_BODY: usize = 3 * 1024 * 1024 + 64 * 1024;
/// How often a stream checks that its share is still live and its thread changed.
const STREAM_POLL: std::time::Duration = std::time::Duration::from_secs(2);
/// Open event streams one share may hold.
const MAX_STREAMS_PER_SHARE: usize = 3;
/// File types a guest may attach.
const ATTACHMENT_TYPES: [&str; 10] = ["png", "jpg", "jpeg", "gif", "webp", "txt", "md", "pdf", "json", "csv"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Endpoint {
    Page,
    Join,
    Snapshot,
    Events,
    Message,
}

/// The guest endpoint a request names, with its token. Part of `route_auth`:
/// anything this does not return is not public.
pub(super) fn parse<'a>(method: &Method, path: &'a str) -> Option<(Endpoint, &'a str)> {
    let rest = path.strip_prefix("/g/")?;
    let mut parts = rest.split('/');
    let token = parts.next().filter(|t| !t.is_empty() && t.len() <= 64)?;
    let sub = parts.next();
    if parts.next().is_some() {
        return None;
    }
    let endpoint = match (sub, method) {
        (None, m) if *m == Method::GET => Endpoint::Page,
        (Some("join"), m) if *m == Method::POST => Endpoint::Join,
        (Some("snapshot"), m) if *m == Method::GET => Endpoint::Snapshot,
        (Some("events"), m) if *m == Method::GET => Endpoint::Events,
        (Some("message"), m) if *m == Method::POST => Endpoint::Message,
        _ => return None,
    };
    Some((endpoint, token))
}

pub(super) fn is_guest_request(method: &Method, path: &str) -> bool {
    parse(method, path).is_some()
}

fn not_found() -> Resp {
    text(StatusCode::NOT_FOUND, "Not found")
}

/// Failed guest requests, counted apart from sign-in so one cannot lock out the
/// other.
fn limiter() -> &'static LoginLimiter {
    static LIMITER: OnceLock<LoginLimiter> = OnceLock::new();
    LIMITER.get_or_init(LoginLimiter::new)
}

/// Normalised page text: the HTML parser turns CRLF into LF before a browser
/// hashes inline code, so the hash below must be taken over LF text too.
fn page_html() -> &'static str {
    static HTML: OnceLock<String> = OnceLock::new();
    HTML.get_or_init(|| PAGE.replace("\r\n", "\n"))
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> &'a str {
    let start = text.find(open).map_or(0, |i| i + open.len());
    let end = text[start..].find(close).map_or(text.len(), |i| i + start);
    &text[start..end]
}

/// The page's policy: nothing loads from anywhere, and the one script and one
/// style block it holds are allowed by hash, so no `unsafe-inline`.
pub(super) fn page_csp() -> &'static str {
    static CSP: OnceLock<String> = OnceLock::new();
    CSP.get_or_init(|| {
        let html = page_html();
        let hash = |part: &str| {
            format!("'sha256-{}'", base64::engine::general_purpose::STANDARD.encode(Sha256::digest(part.as_bytes())))
        };
        format!(
            "default-src 'none'; script-src {}; style-src {}; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; media-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            hash(between(html, "<script>", "</script>")),
            hash(between(html, "<style>", "</style>")),
        )
    })
}

fn page_response() -> Resp {
    let mut response = reply(StatusCode::OK, "text/html; charset=utf-8", page_html());
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(page_csp()).unwrap_or_else(|_| HeaderValue::from_static("default-src 'none'")));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
    response
}

/// The value of cookie `name` when it has the shape of a binder.
fn cookie_value(headers: &hyper::HeaderMap, name: &str) -> Option<String> {
    headers.get(header::COOKIE)?.to_str().ok()?.split(';').find_map(|part| {
        let (n, v) = part.trim().split_once('=')?;
        (n == name && v.len() == 32 && v.bytes().all(|c| c.is_ascii_hexdigit())).then(|| v.to_owned())
    })
}

/// Event streams open per share, so one guest cannot hold the server's sockets.
fn streams() -> &'static Mutex<HashMap<String, usize>> {
    static OPEN: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    OPEN.get_or_init(Default::default)
}

pub(super) struct StreamSlot(String);

impl StreamSlot {
    pub(super) fn take(share_id: &str) -> Option<StreamSlot> {
        let mut open = streams().lock().unwrap_or_else(|e| e.into_inner());
        let count = open.entry(share_id.to_owned()).or_insert(0);
        if *count >= MAX_STREAMS_PER_SHARE {
            return None;
        }
        *count += 1;
        Some(StreamSlot(share_id.to_owned()))
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut open = streams().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = open.get_mut(&self.0) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                open.remove(&self.0);
            }
        }
    }
}

pub(super) async fn guest_route(
    state: &State,
    method: &Method,
    path: &str,
    client: std::net::IpAddr,
    req: Request<Incoming>,
) -> Resp {
    let Some((endpoint, token)) = parse(method, path) else {
        return not_found();
    };
    if limiter().blocked(client) {
        return text(StatusCode::TOO_MANY_REQUESTS, "Too many requests");
    }
    // Another site's page never gets an answer, and a POST must come from this
    // server's own page (a browser always sends Origin on a POST).
    if foreign_origin(state, req.headers()) || (*method == Method::POST && !same_origin(state, req.headers())) {
        return not_found();
    }
    let cookie_name = store::cookie_name_for(&store::hash_text(token));
    let cookie = cookie_value(req.headers(), &cookie_name);
    let mode = match endpoint {
        Endpoint::Page => Mode::Page,
        Endpoint::Join => Mode::Join,
        _ => Mode::Live,
    };
    let (data, owned_token, owned_cookie) = (state.data_folder.clone(), token.to_owned(), cookie.clone());
    let authorized = tokio::task::spawn_blocking(move || {
        Store::new(&data).authorize(&owned_token, owned_cookie.as_deref(), mode, store::now_ms())
    })
    .await;
    let Ok(Ok(access)) = authorized else {
        limiter().record_failure(client);
        return not_found();
    };
    match endpoint {
        Endpoint::Page => page_response(),
        Endpoint::Join => join_response(state, &access, req.headers()),
        Endpoint::Snapshot => snapshot_response(state, &access).await,
        Endpoint::Events => events_response(state, access, token.to_owned(), cookie),
        Endpoint::Message => message_response(state, &access, req).await,
    }
}

fn join_response(state: &State, access: &Access, headers: &hyper::HeaderMap) -> Resp {
    let mut response = reply(StatusCode::OK, "application/json", r#"{"ok":true}"#);
    if let Some(binder) = &access.new_binder {
        let seconds = access.expires_ms.saturating_sub(store::now_ms()) / 1000;
        let secure = if cookie_secure(state, headers) { "; Secure" } else { "" };
        let cookie = format!(
            "{}={binder}; HttpOnly; SameSite=Strict; Path=/g/; Max-Age={seconds}{secure}",
            access.cookie_name
        );
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
    }
    response
}

async fn snapshot_response(state: &State, access: &Access) -> Resp {
    let (root, thread, reasoning) = (state.data_folder.clone(), access.thread_id.clone(), access.include_reasoning);
    match tokio::task::spawn_blocking(move || view::snapshot(&root, &thread, reasoning)).await {
        Ok(Ok(snapshot)) => json(&snapshot),
        // The thread went away between the check and the read.
        _ => not_found(),
    }
}

/// Modification time and length of a thread's message file, to notice a change
/// made by the desktop app, which does not go through this server's event bus.
fn thread_signature(root: &std::path::Path, thread_id: &str) -> Option<(u64, std::time::SystemTime)> {
    let meta = std::fs::metadata(crate::core::threads::utils::get_messages_path(root, thread_id)).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

enum Step {
    Ended,
    Unchanged,
    Frame(Bytes),
}

/// One look at the share: still live? thread changed? Returns the frame to send.
async fn step(
    data: &std::path::Path,
    token: &str,
    cookie: Option<&str>,
    force: bool,
    last: &mut (String, Option<(u64, std::time::SystemTime)>),
) -> Step {
    let (root, token, cookie) = (data.to_path_buf(), token.to_owned(), cookie.map(str::to_owned));
    let looked = tokio::task::spawn_blocking(move || {
        let access = Store::new(&root).authorize(&token, cookie.as_deref(), Mode::Live, store::now_ms()).ok()?;
        let signature = thread_signature(&root, &access.thread_id);
        Some((access, signature, root, force))
    })
    .await;
    let Ok(Some((access, signature, root, force))) = looked else {
        return Step::Ended;
    };
    if !force && signature == last.1 {
        return Step::Unchanged;
    }
    let thread = access.thread_id.clone();
    let projected =
        tokio::task::spawn_blocking(move || view::snapshot(&root, &thread, access.include_reasoning)).await;
    let Ok(Ok(snapshot)) = projected else {
        return Step::Ended;
    };
    last.1 = signature;
    let body = serde_json::to_string(&snapshot).unwrap_or_default();
    if body == last.0 {
        return Step::Unchanged;
    }
    last.0 = body.clone();
    Step::Frame(Bytes::from(format!("event: update\ndata: {body}\n\n")))
}

/// Server-sent events for one guest. The bus only says "this thread changed";
/// what is sent is always the projection (`view::snapshot`), never a bus
/// payload, so nothing on the bus can leak through here. A guest on a
/// desktop-owned thread is covered by the file check on each poll.
fn events_response(state: &State, access: Access, token: String, cookie: Option<String>) -> Resp {
    let Some(slot) = StreamSlot::take(&access.share_id) else {
        return text(StatusCode::TOO_MANY_REQUESTS, "Too many open streams");
    };
    let mut bus = state.events.subscribe();
    let data = state.data_folder.clone();
    let thread_id = access.thread_id.clone();
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(events::SSE_QUEUE);
    tokio::spawn(async move {
        let _slot = slot;
        let mut last = (String::new(), None);
        let mut ticks = 0u32;
        if !events::put(&tx, Bytes::from_static(b": connected\n\n")).await {
            return;
        }
        let mut force = true;
        let mut tick = tokio::time::interval(STREAM_POLL);
        loop {
            match step(&data, &token, cookie.as_deref(), force, &mut last).await {
                Step::Ended => {
                    let _ = events::put(&tx, Bytes::from_static(b"event: ended\ndata: {}\n\n")).await;
                    return;
                }
                Step::Unchanged => {}
                Step::Frame(frame) => {
                    if !events::offer(&tx, frame) {
                        return;
                    }
                }
            }
            force = false;
            tokio::select! {
                received = bus.recv() => match received {
                    Ok(line) => force = view::is_thread_change(&line, &thread_id),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => force = true,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                },
                _ = tick.tick() => {
                    ticks += 1;
                    if ticks % 8 == 0 && !events::offer(&tx, Bytes::from_static(b": keepalive\n\n")) {
                        return;
                    }
                }
            }
        }
    });
    let body = http_body_util::StreamBody::new(tokio_stream::StreamExt::map(
        tokio_stream::wrappers::ReceiverStream::new(rx),
        |bytes| Ok::<_, std::convert::Infallible>(hyper::body::Frame::data(bytes)),
    ));
    let mut response = Response::new(body.boxed_unsync());
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    response
}

/// What a guest's request body held, checked.
struct Posted {
    text: String,
    files: Vec<(String, Vec<u8>)>,
}

fn parse_message(body: &serde_json::Value) -> Result<Posted, &'static str> {
    let text = str_field(body, "text")
        .and_then(view::clean_guest_text)
        .ok_or("Write a message first (up to 4000 characters).")?;
    let mut files = Vec::new();
    if let Some(list) = body.get("attachments") {
        let list = list.as_array().ok_or("Attachments must be a list.")?;
        if list.len() > store::MAX_ATTACHMENTS {
            return Err("Too many attachments.");
        }
        for item in list {
            let name = str_field(item, "name").unwrap_or_default();
            let extension = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
            if !ATTACHMENT_TYPES.contains(&extension.as_str()) {
                return Err("That kind of file cannot be attached.");
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(str_field(item, "data").unwrap_or_default())
                .map_err(|_| "An attachment could not be read.")?;
            if bytes.is_empty() || bytes.len() > store::MAX_ATTACHMENT_BYTES {
                return Err("An attachment is empty or over 1 MB.");
            }
            files.push((name.to_owned(), bytes));
        }
    }
    Ok(Posted { text, files })
}

async fn message_response(state: &State, access: &Access, req: Request<Incoming>) -> Resp {
    let body = match read_json_max(req, MAX_GUEST_BODY).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let incoming = match parse_message(&body) {
        Ok(incoming) => incoming,
        Err(message) => return text(StatusCode::BAD_REQUEST, message),
    };
    let (root, share_id) = (state.data_folder.clone(), access.share_id.clone());
    let queued = tokio::task::spawn_blocking(move || {
        let mut stored: Vec<Attachment> = Vec::new();
        for (name, bytes) in &incoming.files {
            match uploads::store(&root, name, bytes) {
                Ok(v) => stored.push(Attachment {
                    id: v["id"].as_str().unwrap_or_default().to_owned(),
                    name: v["name"].as_str().unwrap_or_default().to_owned(),
                    size: v["size"].as_u64().unwrap_or_default(),
                    path: v["path"].as_str().unwrap_or_default().to_owned(),
                }),
                Err(_) => {
                    for a in &stored {
                        let _ = uploads::delete(&root, &a.id);
                    }
                    return Err(QueueError::Io("could not store the attachment".into()));
                }
            }
        }
        let ids: Vec<String> = stored.iter().map(|a| a.id.clone()).collect();
        let result = Store::new(&root).queue_message(&share_id, incoming.text, stored, store::now_ms());
        if result.is_err() {
            for id in ids {
                let _ = uploads::delete(&root, &id);
            }
        }
        result
    })
    .await;
    match queued {
        Ok(Ok(_)) => reply(StatusCode::ACCEPTED, "application/json", r#"{"queued":true}"#),
        Ok(Err(QueueError::TooFast)) => text(StatusCode::TOO_MANY_REQUESTS, "Slow down."),
        Ok(Err(QueueError::TooMany)) => text(StatusCode::TOO_MANY_REQUESTS, "Too many messages are waiting."),
        Ok(Err(QueueError::Gone)) => not_found(),
        _ => text(StatusCode::INTERNAL_SERVER_ERROR, "Could not queue the message."),
    }
}

/// Tells the event bus a thread's messages changed (ids only, no content), so a
/// guest following it looks again at once.
pub(super) fn announce_message(state: &State, thread_id: &str, message_id: &str) {
    state.events.publish("thread-message", &serde_json::json!({ "threadId": thread_id, "messageId": message_id }));
}

#[cfg(test)]
mod csp_header_tests {
    use super::*;

    #[test]
    fn page_response_carries_the_page_csp() {
        let response = page_response();
        let value = response.headers().get(header::CONTENT_SECURITY_POLICY).map(|v| v.to_str().unwrap_or_default());
        assert_eq!(value, Some(page_csp()));
    }
}
