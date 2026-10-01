//! The Cowork session's live preview (a dev server on this computer, e.g.
//! `http://localhost:5173`), shown on a paired phone through this server.
//!
//! Not an open proxy:
//! - Only the one origin the window registered for the session in view
//!   (`remote_set_preview`), and only a loopback `http(s)` origin.
//! - Only `GET`/`HEAD`. No WebSocket, so a dev server's hot reload does not
//!   reach the phone (reload instead).
//! - Only with a ticket: a phone asks for one over the authenticated RPC
//!   (`preview.ticket`); it is random, bound to that device and session, and
//!   expires. An `<iframe>` cannot send `Authorization`, so the ticket rides
//!   in the path (`/remote/v1/preview/<ticket>/...`) and, for the absolute
//!   paths dev servers use (`/src/main.tsx`, `/@vite/client`), in an HttpOnly
//!   cookie scoped to this listener.
//! - Every proxied response carries `Content-Security-Policy: sandbox`, so
//!   the previewed page runs in an opaque origin and can never read the phone
//!   app's storage (where the device token lives), even if opened top-level.

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const TICKET_TTL: Duration = Duration::from_secs(30 * 60);
pub const PREVIEW_PREFIX: &str = "/preview/";
pub const COOKIE: &str = "flint_pv";
/// The largest proxied response.
pub const MAX_PREVIEW_BODY: usize = 25 * 1024 * 1024;
pub const SANDBOX_CSP: &str =
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/// `scheme://host:port` when `url` is an app on this machine.
pub fn local_origin(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let local = match u.host()? {
        url::Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    };
    local.then(|| u.origin().ascii_serialization())
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreviewTarget {
    pub session_id: String,
    pub origin: String,
    /// Path (and query) of the URL the desktop shows, the phone's start page.
    pub start: String,
}

impl PreviewTarget {
    pub fn new(session_id: &str, url: &str) -> Option<Self> {
        let origin = local_origin(url)?;
        let u = url::Url::parse(url).ok()?;
        let mut start = u.path().to_string();
        if let Some(q) = u.query() {
            start.push('?');
            start.push_str(q);
        }
        Some(Self {
            session_id: session_id.into(),
            origin,
            start,
        })
    }
}

#[derive(Debug, Clone)]
struct Ticket {
    device_id: String,
    session_id: String,
    expires: Instant,
}

#[derive(Debug, Default)]
pub struct TicketBook {
    tickets: HashMap<String, Ticket>,
}

impl TicketBook {
    pub fn issue(&mut self, device_id: &str, session_id: &str, now: Instant) -> String {
        self.tickets.retain(|_, t| t.expires > now);
        let id = super::auth::random_b64(24);
        self.tickets.insert(
            id.clone(),
            Ticket {
                device_id: device_id.into(),
                session_id: session_id.into(),
                expires: now + TICKET_TTL,
            },
        );
        id
    }

    /// The device and session a live ticket belongs to.
    pub fn check(&self, ticket: &str, now: Instant) -> Option<(String, String)> {
        self.tickets
            .get(ticket)
            .filter(|t| t.expires > now)
            .map(|t| (t.device_id.clone(), t.session_id.clone()))
    }

    pub fn revoke_device(&mut self, device_id: &str) {
        self.tickets.retain(|_, t| t.device_id != device_id);
    }
}

/// `/preview/<ticket>/<rest>` -> (ticket, "/rest").
pub fn split_preview_path(api: &str) -> Option<(&str, String)> {
    let rest = api.strip_prefix(PREVIEW_PREFIX)?;
    let (ticket, path) = rest.split_once('/').unwrap_or((rest, ""));
    if ticket.is_empty() || ticket.len() > 64 || !ticket.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some((ticket, format!("/{path}")))
}

/// The ticket in a `Cookie` header.
pub fn ticket_from_cookie(header: &str) -> Option<&str> {
    header
        .split(';')
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v)
}

/// A path the dev server may be asked for: absolute, no scheme or host, no
/// climbing tricks that `url` would normalise away from the origin.
pub fn upstream_url(origin: &str, path_and_query: &str) -> Option<String> {
    if !path_and_query.starts_with('/') || path_and_query.starts_with("//") || path_and_query.contains('\\') {
        return None;
    }
    let joined = url::Url::parse(&format!("{origin}{path_and_query}")).ok()?;
    (joined.origin().ascii_serialization() == origin).then(|| joined.to_string())
}

/// A redirect back to the dev server becomes a path on this listener.
pub fn rewrite_location(origin: &str, location: &str, ticket: &str) -> Option<String> {
    if let Some(rest) = location.strip_prefix(origin) {
        let rest = if rest.is_empty() { "/" } else { rest };
        return Some(format!("{}{}{ticket}{rest}", super::server::API_PREFIX, PREVIEW_PREFIX));
    }
    if location.starts_with('/') && !location.starts_with("//") {
        return Some(format!("{}{}{ticket}{location}", super::server::API_PREFIX, PREVIEW_PREFIX));
    }
    // Elsewhere: not followed through this server.
    None
}

/// Response headers passed back from the dev server.
pub const PASS_HEADERS: &[&str] = &[
    "content-type",
    "content-language",
    "etag",
    "last-modified",
];
