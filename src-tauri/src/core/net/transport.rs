//! The one path every OpenAI-compatible provider request takes.
//!
//! Model discovery, chat completions (streaming and not), embeddings, health
//! checks and connection tests all go through `send` / `send_stream` here, so
//! there is exactly one place where a provider endpoint is resolved and exactly
//! one set of rules about which address is dialled.
//!
//! The URL is never rewritten. Selection happens in the connector: the client
//! for an endpoint carries a [`ResolverCache`]-backed [`reqwest::dns::Resolve`]
//! that answers with the addresses we are willing to dial, in the order we want
//! them tried. The request still carries the configured hostname, so the `Host`
//! header, the TLS server name, the port, the path and the query are exactly
//! what the user typed.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use base64::Engine as _;
use futures_util::StreamExt;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use tauri_plugin_agent_tools::snapshot::{self, DispatchKind, Identity as SnapshotIdentity};

use crate::core::app::commands::resolve_jan_data_folder;

use super::resolver::{self, DnsProbe, ResolverCache, SystemDns};

/// What `reqwest::dns::Resolving` carries on failure.
type BoxDynError = Box<dyn std::error::Error + Send + Sync>;

/// The resolver the transport asks. Replaceable so a smoke run can pin the
/// answers for a hostname without touching the request path itself.
fn probe_slot() -> &'static RwLock<Option<Arc<dyn DnsProbe>>> {
    static PROBE: OnceLock<RwLock<Option<Arc<dyn DnsProbe>>>> = OnceLock::new();
    PROBE.get_or_init(|| RwLock::new(None))
}

/// Install a resolver. Production never calls this -- the default is the system
/// resolver -- so the only callers are the smoke harness and tests, which need
/// the answers for a hostname to be the same on every machine.
pub fn set_probe(probe: Arc<dyn DnsProbe>) {
    if let Ok(mut slot) = probe_slot().write() {
        *slot = Some(probe);
    }
    // A pinned resolver that arrives after an endpoint was already resolved
    // would otherwise be ignored until the entry aged out.
    invalidate_all();
}

fn probe() -> Arc<dyn DnsProbe> {
    probe_slot()
        .read()
        .ok()
        .and_then(|p| p.clone())
        .unwrap_or_else(|| Arc::new(SystemDns))
}

/// Bridges our decision to hyper's connector.
struct EndpointResolver {
    port: u16,
    cache: Arc<ResolverCache>,
}

impl Resolve for EndpointResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let port = self.port;
        let cache = self.cache.clone();
        Box::pin(async move {
            // `getaddrinfo` blocks; keep it off the reactor.
            let resolved =
                tokio::task::spawn_blocking(move || cache.resolve(probe().as_ref(), &host, port))
                    .await
                    .map_err(|e| -> BoxDynError {
                        Box::new(std::io::Error::other(e.to_string()))
                    })?;

            match resolved {
                // Every eligible address is handed over, in preference order,
                // so hyper falls through to the next one on a refused
                // connection without another lookup.
                Ok(r) => Ok(Box::new(r.order.into_iter()) as Addrs),
                Err(e) => Err(Box::new(std::io::Error::other(e)) as BoxDynError),
            }
        })
    }
}

/// One client per endpoint, because the resolver has to know the port and the
/// `Resolve` trait is only given the hostname.
fn clients() -> &'static Mutex<HashMap<(String, u16), Client>> {
    static CLIENTS: OnceLock<Mutex<HashMap<(String, u16), Client>>> = OnceLock::new();
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn endpoint_of(url: &str) -> Result<(String, u16), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("{url} is not a URL: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("{url} has no host"))?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| format!("{url} has no port and no default for its scheme"))?;
    Ok((host, port))
}

fn client_for(host: &str, port: u16) -> Result<Client, String> {
    // AH-190: clients built under another CA bundle are not reused.
    static BUILT_FOR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let bundle = crate::core::net::tls::fingerprint();
    if BUILT_FOR.swap(bundle, Ordering::SeqCst) != bundle {
        if let Ok(mut cache) = clients().lock() {
            cache.clear();
        }
    }
    let key = (host.to_ascii_lowercase(), port);
    if let Some(existing) = clients().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(existing);
    }
    let client = crate::core::net::tls::apply12(
        Client::builder()
            .dns_resolver(Arc::new(EndpointResolver {
                port,
                cache: resolver::shared().clone(),
            }))
            // A local server that is down should fail quickly enough that the next
            // candidate is tried while the user is still watching.
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(30))
            .redirect(same_origin_redirects()),
    )
    .build()
        .map_err(|e| format!("could not build an HTTP client for {host}:{port}: {e}"))?;
    if let Ok(mut cache) = clients().lock() {
        cache.insert(key, client.clone());
    }
    Ok(client)
}

/// How many redirects a request may follow, as reqwest's default allowed.
const MAX_REDIRECTS: usize = 10;

/// Whether `next` is the same server as `first`, or the same host moved from
/// `http` to `https` on the default ports.
fn same_origin(first: &url::Url, next: &url::Url) -> bool {
    if first.host_str() != next.host_str() {
        return false;
    }
    let (a, b) = (first.port_or_known_default(), next.port_or_known_default());
    (first.scheme() == next.scheme() && a == b)
        || (first.scheme() == "http" && next.scheme() == "https" && a == Some(80) && b == Some(443))
}

/// Follow a redirect only while it stays on the server the request was sent
/// to. janhq/jan#8208.
///
/// reqwest's default follows any redirect and drops only `Authorization`,
/// `Cookie` and the proxy credentials when the host changes. Every other
/// header went on to the new host: `x-api-key`, `x-goog-api-key` and every
/// custom header, a subscription key or a tenant token among them. A provider
/// that answers with a redirect to somewhere else now gets an error naming
/// where it tried to send the request, and nothing is sent there.
pub(crate) fn same_origin_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > MAX_REDIRECTS {
            return attempt.error("too many redirects");
        }
        let Some(first) = attempt.previous().first() else {
            return attempt.follow();
        };
        if same_origin(first, attempt.url()) {
            return attempt.follow();
        }
        let to = attempt.url().origin().ascii_serialization();
        attempt.error(format!(
            "refused to follow a redirect to another server ({to}): the request's \
             headers, its keys among them, would have gone there too. Point the \
             provider's base URL at the server that answers."
        ))
    })
}

/// Forget an endpoint: a provider was edited, the network changed, or the user
/// asked for a retry. Both the addresses and the pooled connections go.
pub fn invalidate(host: &str, port: u16) {
    resolver::shared().invalidate(host, port);
    if let Ok(mut cache) = clients().lock() {
        cache.remove(&(host.to_ascii_lowercase(), port));
    }
}

pub fn invalidate_all() {
    resolver::shared().invalidate_all();
    if let Ok(mut cache) = clients().lock() {
        cache.clear();
    }
}

/// A provider request, as the web app describes it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// UTF-8 request body. Provider APIs are JSON, so there is no binary case.
    #[serde(default)]
    pub body: Option<String>,
    /// Seconds. `None` leaves it to the server and the user.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Who this request belongs to, so a snapshot of it can be found again.
    ///
    /// Absent for a request that is not a model dispatch (model discovery, a
    /// health check), which is not snapshotted at all.
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub thread: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    /// Identifies this dispatch, assigned by the caller before it is sent.
    ///
    /// The timeline attaches the snapshot to this id rather than to whichever
    /// reply happened to arrive next: one turn can hold several dispatches --
    /// a continuation after tool results, a retry, a compaction -- and a late
    /// one must not land on a later turn.
    #[serde(default)]
    pub invocation_id: Option<String>,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub attempt: Option<u32>,
    /// `initial`, `continuation`, `retry` or `compaction`.
    #[serde(default)]
    pub kind: Option<String>,
    /// Names this stream so it can be cancelled.
    ///
    /// A consumer that stops reading -- the AI SDK abandoning a body once it
    /// has seen the terminator, or a run being stopped -- must be able to end
    /// the request, or the connection is held open and whoever is waiting for
    /// the body to finish waits forever.
    #[serde(default)]
    pub stream_id: Option<String>,
}

/// How often a stalled read looks at the cancellation flag.
const CANCEL_POLL: Duration = Duration::from_millis(100);

/// Streams currently in flight, by the id the caller gave them.
fn live_streams() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static LIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ask a stream to stop. Unknown ids are ignored: the stream may already have
/// finished on its own, which is not an error.
pub fn cancel_stream(stream_id: &str) {
    if let Ok(live) = live_streams().lock() {
        if let Some(flag) = live.get(stream_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Registers a stream for the duration of the request and removes it after.
struct StreamGuard {
    id: Option<String>,
    cancelled: Arc<AtomicBool>,
}

impl StreamGuard {
    fn new(id: Option<String>) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(id) = &id {
            if let Ok(mut live) = live_streams().lock() {
                live.insert(id.clone(), cancelled.clone());
            }
        }
        Self { id, cancelled }
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            if let Ok(mut live) = live_streams().lock() {
                live.remove(id);
            }
        }
    }
}

/// A reference to the snapshot taken of a dispatched request.
///
/// Carries the id and hash, never the payload: the timeline links to the
/// stored record rather than holding a copy that could drift from it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    pub id: String,
    pub hash: String,
    pub redactions: usize,
    /// The dispatch this snapshot is of, echoed back so the caller can attach
    /// it to the exact invocation it asked about.
    pub invocation: String,
}

/// Record what is about to be sent, if this is a model dispatch.
///
/// The transport is the last point before the request leaves the process, and
/// the only one every provider call passes through -- which is exactly what a
/// prompt snapshot has to be taken at. A request with no session is not a
/// dispatch (discovery, a health check) and is not recorded.
fn capture_snapshot(req: &ProviderRequest) -> Option<SnapshotRef> {
    let body = req.body.as_deref()?;
    let payload: serde_json::Value = serde_json::from_str(body).ok()?;
    // A chat dispatch, not an arbitrary POST.
    if !payload.get("messages").is_some_and(|m| m.is_array()) {
        return None;
    }
    let Some(session) = req.session.as_deref() else {
        // A dispatch that arrived without knowing whose conversation it is
        // cannot be filed against one, and the panel would have nothing to
        // look up. Say so rather than dropping it silently.
        log::warn!(
            "prompt snapshot: a dispatch to {} carried no session; \
             the x-jan-session header did not survive the fetch chain",
            req.url
        );
        return None;
    };
    let invocation = req.invocation_id.clone().unwrap_or_default();
    let identity = SnapshotIdentity {
        session: session.to_string(),
        run: req.run.clone().unwrap_or_default(),
        thread: req.thread.clone().unwrap_or_default(),
        agent: req.agent.clone().unwrap_or_default(),
        provider: req.provider.clone().unwrap_or_default(),
        invocation: invocation.clone(),
        turn: req.turn_id.clone().unwrap_or_default(),
        attempt: req.attempt.unwrap_or(1),
        kind: match req.kind.as_deref() {
            Some("continuation") => DispatchKind::Continuation,
            Some("retry") => DispatchKind::Retry,
            Some("compaction") => DispatchKind::Compaction,
            // An unrecognised value is not silently treated as a retry: an
            // unknown dispatch is a first one until something says otherwise.
            _ => DispatchKind::Initial,
        },
    };
    let snapshot = snapshot::capture(&payload, &identity);
    snapshot::append(&resolve_jan_data_folder(), &snapshot);
    Some(SnapshotRef {
        id: snapshot.id.clone(),
        hash: snapshot.hash.clone(),
        redactions: snapshot.redactions.len(),
        invocation,
    })
}

fn default_method() -> String {
    "GET".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
    /// Which address actually answered, when the transport could tell.
    pub peer: Option<String>,
    /// The snapshot taken of this request, when it was a model dispatch.
    pub snapshot: Option<SnapshotRef>,
}

/// One streamed piece of a response.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamChunk {
    /// Status and headers, before any body.
    Head {
        status: u16,
        status_text: String,
        headers: HashMap<String, String>,
        peer: Option<String>,
        snapshot: Option<SnapshotRef>,
    },
    /// Base64 so a chunk that splits a multi-byte character survives the trip.
    Data {
        b64: String,
    },
    End,
    Error {
        message: String,
    },
}

fn build(client: &Client, req: &ProviderRequest) -> Result<reqwest::RequestBuilder, String> {
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|_| format!("{} is not an HTTP method", req.method))?;
    let mut builder = client.request(method, &req.url);
    for (name, value) in &req.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }
    if let Some(secs) = req.timeout_secs {
        builder = builder.timeout(Duration::from_secs(secs));
    }
    Ok(builder)
}

fn header_map(response: &reqwest::Response) -> HashMap<String, String> {
    response
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|v| (k.as_str().to_string(), v.to_string()))
        })
        .collect()
}

/// Note the peer we actually reached, so diagnostics can say so.
fn note_peer(host: &str, port: u16, response: &reqwest::Response) -> Option<SocketAddr> {
    let peer = response.remote_addr();
    if let Some(addr) = peer {
        resolver::shared().record_peer(host, port, addr);
    }
    peer
}

/// A transport failure -- no HTTP response at all. A 401 or 403 from the server
/// we selected is a response and never reaches here, so a real refusal is never
/// reported as a name-resolution problem.
fn transport_failed(host: &str, port: u16, e: &reqwest::Error) -> String {
    let diag = describe(host, port)
        .map(|d| format!(" ({d})"))
        .unwrap_or_default();
    // The addresses we chose are stale the moment a connection to them fails.
    invalidate(host, port);
    let what = if e.is_connect() {
        "could not connect"
    } else if e.is_timeout() {
        "timed out"
    } else {
        "failed"
    };
    // reqwest's own text stops at the kind of failure ("error following
    // redirect"); the reason is in the source chain.
    let mut reason = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        let text = s.to_string();
        if !reason.contains(&text) {
            reason.push_str(": ");
            reason.push_str(&text);
        }
        source = s.source();
    }
    // R13: a certificate failure is named as one, not left to be read out of
    // an operating system message.
    if let Some(certificate) = crate::core::net::tls::certificate_failure(e) {
        reason.push_str(&format!(" [certificate: {certificate}]"));
    }
    format!("{host}:{port} {what}{diag}: {reason}")
}

/// A credential-free, one-line account of what was resolved and chosen.
pub fn describe(host: &str, port: u16) -> Option<String> {
    let r = resolver::shared().peek(host, port)?;
    let candidates = r
        .candidates
        .iter()
        .map(|c| {
            format!(
                "{} [{}{}]",
                c.addr.ip(),
                c.class.as_str(),
                if c.eligible { "" } else { ", suppressed" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let selected = r
        .selected()
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "none".to_string());
    Some(format!("resolved {candidates}; selected {selected}"))
}

/// An error response's body with every value the user marked secret replaced.
/// janhq/jan#8208. A success body is the model's output and is left alone.
fn redact_error_body(status: reqwest::StatusCode, body: String) -> String {
    if status.is_success() {
        return body;
    }
    match crate::core::secret_values::scrub(&body) {
        std::borrow::Cow::Owned(redacted) => redacted,
        std::borrow::Cow::Borrowed(_) => body,
    }
}

/// Send a provider request and read the whole response.
pub async fn send(req: ProviderRequest) -> Result<ProviderResponse, String> {
    let (host, port) = endpoint_of(&req.url)?;
    let client = client_for(&host, port)?;
    // Taken from the request as it stands here, at the last point before it
    // leaves the process.
    let snapshot = capture_snapshot(&req);
    let response = build(&client, &req)?
        .send()
        .await
        .map_err(|e| transport_failed(&host, port, &e))?;

    let peer = note_peer(&host, port, &response);
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let headers = header_map(&response);
    let body = response
        .text()
        .await
        .map_err(|e| format!("{host}:{port} answered but the body could not be read: {e}"))?;
    let body = redact_error_body(status, body);

    Ok(ProviderResponse {
        status: status.as_u16(),
        status_text,
        headers,
        body,
        peer: peer.map(|p| p.to_string()),
        snapshot,
    })
}

/// Where streamed chunks go. An abstraction only so the streaming path can be
/// exercised without a webview.
pub trait ChunkSink: Send + 'static {
    fn send(&self, chunk: StreamChunk);
}

/// Send a provider request and hand the body back a chunk at a time.
pub async fn send_stream<S: ChunkSink>(req: ProviderRequest, sink: S) -> Result<(), String> {
    let (host, port) = endpoint_of(&req.url)?;
    let client = client_for(&host, port)?;
    let snapshot = capture_snapshot(&req);
    let guard = StreamGuard::new(req.stream_id.clone());
    let response = match build(&client, &req)?.send().await {
        Ok(r) => r,
        Err(e) => {
            let message = transport_failed(&host, port, &e);
            sink.send(StreamChunk::Error {
                message: message.clone(),
            });
            return Err(message);
        }
    };

    let peer = note_peer(&host, port, &response);
    let status = response.status();
    sink.send(StreamChunk::Head {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: header_map(&response),
        peer: peer.map(|p| p.to_string()),
        snapshot,
    });

    // An error body is read whole and redacted before the webview sees it:
    // it is shown to the user and kept in the thread, and a gateway that
    // echoes the request back would otherwise put a secret header's value in
    // both. Error bodies are small; a chunk-by-chunk redaction could miss a
    // value split across two chunks.
    if !status.is_success() {
        let body = match response.text().await {
            Ok(body) => redact_error_body(status, body),
            Err(e) => {
                let message = transport_failed(&host, port, &e);
                sink.send(StreamChunk::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        };
        sink.send(StreamChunk::Data {
            b64: base64::engine::general_purpose::STANDARD.encode(body.as_bytes()),
        });
        sink.send(StreamChunk::End);
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    loop {
        // Checking the flag only when a chunk arrives is not enough: a server
        // that has stopped sending but not closed leaves this awaiting a chunk
        // that never comes, which is the case cancellation exists for. So the
        // read is raced against the flag rather than gated on it.
        let next = loop {
            if guard.cancelled() {
                // Dropping the response ends the request rather than holding
                // the connection open for a body nobody will read.
                sink.send(StreamChunk::End);
                return Ok(());
            }
            match tokio::time::timeout(CANCEL_POLL, stream.next()).await {
                Ok(Some(item)) => break item,
                Ok(None) => {
                    sink.send(StreamChunk::End);
                    return Ok(());
                }
                Err(_) => continue,
            }
        };
        match next {
            Ok(bytes) => sink.send(StreamChunk::Data {
                b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            }),
            Err(e) => {
                // A stream that dies mid-body is a transport failure like any
                // other; the next attempt should re-resolve.
                let message = transport_failed(&host, port, &e);
                sink.send(StreamChunk::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        }
    }
}

#[cfg(test)]
// `pin` holds a process-wide lock for a whole test on purpose: the resolver it
// installs is global, so tests that install one must not overlap.
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_model_dispatch_is_snapshotted_and_the_reference_comes_back() {
        let (port, _requests) = serve(OK_JSON, 1);
        let _guard = pin(vec![ip("127.0.0.1")]);

        let response = send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/chat/completions"),
            method: "POST".into(),
            headers: HashMap::from([("Authorization".into(), "Bearer sk-not-a-real-key".into())]),
            body: Some(
                r#"{"model":"qwen3.8-27b","messages":[{"role":"user","content":"hi"}]}"#.into(),
            ),
            timeout_secs: Some(10),
            session: Some("s1".into()),
            run: Some("r1".into()),
            provider: Some("local".into()),
            ..Default::default()
        })
        .await
        .unwrap();

        let taken = response.snapshot.expect("a chat dispatch is snapshotted");
        assert!(taken.hash.starts_with("fnv1a64:"), "{}", taken.hash);
        assert!(!taken.id.is_empty());

        // And it is retrievable with the scope it belongs to.
        let found = tauri_plugin_agent_tools::snapshot::scoped_lookup(
            &resolve_jan_data_folder(),
            Some(&taken.id),
            Some("r1"),
            Some("s1"),
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].model, "qwen3.8-27b");
        // The stored record was redacted before it was written.
        let stored = serde_json::to_string(&found[0]).unwrap();
        assert!(!stored.contains("sk-not-a-real-key"), "{stored}");
    }

    #[tokio::test]
    async fn a_request_that_is_not_a_dispatch_is_not_snapshotted() {
        let (port, _requests) = serve(OK_JSON, 2);
        let _guard = pin(vec![ip("127.0.0.1")]);

        // Model discovery: no session, and no messages.
        let discovery = send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/models"),
            method: "GET".into(),
            timeout_secs: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(discovery.snapshot.is_none());

        // A POST that carries no conversation is not a dispatch either.
        let other = send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/embeddings"),
            method: "POST".into(),
            body: Some(r#"{"model":"e5","input":"hi"}"#.into()),
            timeout_secs: Some(10),
            session: Some("s1".into()),
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(other.snapshot.is_none());
    }

    #[tokio::test]
    async fn a_streamed_dispatch_reports_its_snapshot_on_the_head() {
        const SSE: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: [DONE]\n\n";
        let (port, _requests) = serve(SSE, 1);
        let _guard = pin(vec![ip("127.0.0.1")]);

        struct Collect(std::sync::Arc<Mutex<Vec<StreamChunk>>>);
        impl ChunkSink for Collect {
            fn send(&self, chunk: StreamChunk) {
                self.0.lock().unwrap().push(chunk);
            }
        }
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        send_stream(
            ProviderRequest {
                url: format!("http://llm-host:{port}/v1/chat/completions"),
                method: "POST".into(),
                body: Some(
                    r#"{"model":"qwen3.8-27b","messages":[{"role":"user","content":"hi"}],"stream":true}"#
                        .into(),
                ),
                timeout_secs: Some(10),
                session: Some("s2".into()),
                ..Default::default()
            },
            Collect(seen.clone()),
        )
        .await
        .unwrap();

        let chunks = seen.lock().unwrap();
        match &chunks[0] {
            StreamChunk::Head { snapshot, .. } => {
                let taken = snapshot.as_ref().expect("streamed dispatch is snapshotted");
                assert!(taken.hash.starts_with("fnv1a64:"));
            }
            other => panic!("expected a head chunk, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_cancelled_stream_ends_instead_of_holding_the_connection() {
        // A server that sends a chunk and then keeps the connection open: the
        // shape that made a run wait forever for a body nobody was reading.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\ne\r\ndata: {\"a\":1}\n\r\n",
                );
                let _ = stream.flush();
                // Never terminates the chunked body.
                std::thread::sleep(Duration::from_secs(30));
            }
        });
        let _guard = pin(vec![ip("127.0.0.1")]);

        struct Collect(std::sync::Arc<Mutex<Vec<StreamChunk>>>);
        impl ChunkSink for Collect {
            fn send(&self, chunk: StreamChunk) {
                if let StreamChunk::Data { .. } = chunk {
                    // The consumer has what it wanted and lets go.
                    cancel_stream("cancel-me");
                }
                self.0.lock().unwrap().push(chunk);
            }
        }
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));

        let done = tokio::time::timeout(
            Duration::from_secs(10),
            send_stream(
                ProviderRequest {
                    url: format!("http://llm-host:{port}/v1/chat/completions"),
                    method: "POST".into(),
                    body: Some("{}".into()),
                    timeout_secs: Some(20),
                    stream_id: Some("cancel-me".into()),
                    ..Default::default()
                },
                Collect(seen.clone()),
            ),
        )
        .await;

        assert!(
            done.is_ok(),
            "a cancelled stream must not wait for the server"
        );
        done.unwrap().unwrap();
        let chunks = seen.lock().unwrap();
        assert!(matches!(chunks.last(), Some(StreamChunk::End)));
    }

    #[test]
    fn cancelling_a_stream_nobody_is_running_is_not_an_error() {
        cancel_stream("no-such-stream");
    }

    #[tokio::test]
    async fn each_attempt_is_its_own_record_under_its_own_invocation() {
        let (port, _requests) = serve(OK_JSON, 2);
        let _guard = pin(vec![ip("127.0.0.1")]);

        let dispatch = |invocation: &str, kind: &str, content: &str| ProviderRequest {
            url: format!("http://llm-host:{port}/v1/chat/completions"),
            method: "POST".into(),
            body: Some(format!(
                r#"{{"model":"m","messages":[{{"role":"user","content":"{content}"}}]}}"#
            )),
            timeout_secs: Some(10),
            session: Some("s1".into()),
            invocation_id: Some(invocation.to_string()),
            turn_id: Some("t1".into()),
            attempt: Some(if kind == "retry" { 2 } else { 1 }),
            kind: Some(kind.to_string()),
            ..Default::default()
        };

        let first = send(dispatch("inv-1", "initial", "hi")).await.unwrap();
        let retry = send(dispatch("inv-2", "retry", "hi")).await.unwrap();

        let a = first.snapshot.expect("the first dispatch is recorded");
        let b = retry.snapshot.expect("the retry is recorded too");
        // Separate records under separate invocations, so a retry can never be
        // mistaken for the attempt before it.
        assert_eq!(a.invocation, "inv-1");
        assert_eq!(b.invocation, "inv-2");
        assert_ne!(a.id, b.id);
        // Same payload, so the same hash: the hash identifies what was sent,
        // and that is what makes an approved payload verifiable.
        assert_eq!(a.hash, b.hash);

        let found = tauri_plugin_agent_tools::snapshot::scoped_lookup(
            &resolve_jan_data_folder(),
            Some(&b.id),
            None,
            Some("s1"),
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].invocation, "inv-2");
        assert_eq!(found[0].attempt, 2);
        assert_eq!(
            found[0].kind,
            tauri_plugin_agent_tools::snapshot::DispatchKind::Retry
        );
        assert_eq!(found[0].turn, "t1");
    }

    #[test]
    fn an_endpoint_is_the_host_and_the_port_that_will_actually_be_dialled() {
        assert_eq!(
            endpoint_of("http://llm-host:8080/v1/models").unwrap(),
            ("llm-host".to_string(), 8080)
        );
        // The scheme's default port, since that is what gets connected to.
        assert_eq!(
            endpoint_of("https://api.openai.com/v1").unwrap(),
            ("api.openai.com".to_string(), 443)
        );
        assert_eq!(
            endpoint_of("http://llm-host/v1").unwrap(),
            ("llm-host".to_string(), 80)
        );
        assert!(endpoint_of("not a url").is_err());
    }

    // --- End-to-end over real sockets -------------------------------------
    //
    // These exercise the production `send`/`send_stream` path. Only the name
    // lookup is pinned; everything after it -- client construction, address
    // selection, connection, headers, body, streaming -- is what the app runs.

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// Answers a fixed set of addresses for any hostname.
    struct Pinned(Vec<std::net::IpAddr>);
    impl DnsProbe for Pinned {
        fn lookup(&self, _host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
            Ok(self.0.iter().map(|ip| SocketAddr::new(*ip, port)).collect())
        }
    }

    fn ip(s: &str) -> std::net::IpAddr {
        s.parse().unwrap()
    }

    /// A one-shot HTTP/1.1 server on loopback. Returns its port and a receiver
    /// carrying the raw request head of each connection it served.
    fn serve(response: &'static str, connections: usize) -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for _ in 0..connections {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (port, rx)
    }

    /// Serialises the tests that install a resolver, since it is process-wide.
    fn pin(addrs: Vec<std::net::IpAddr>) -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set_probe(Arc::new(Pinned(addrs)));
        guard
    }

    const OK_JSON: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 31\r\nConnection: close\r\n\r\n{\"data\":[{\"id\":\"qwen3.8-27b\"}]}";

    #[tokio::test]
    async fn a_short_name_reaches_the_private_server_and_never_the_public_one() {
        // The public address is a documentation range that would hang or refuse
        // if it were ever dialled; the test passing at all is the assertion.
        let (port, requests) = serve(OK_JSON, 1);
        let _guard = pin(vec![ip("203.0.113.9"), ip("127.0.0.1")]);

        let response = send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/models"),
            method: "GET".into(),
            headers: HashMap::new(),
            body: None,
            timeout_secs: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert!(response.body.contains("qwen3.8-27b"), "{}", response.body);

        let head = requests.recv().unwrap();
        // The hostname the user configured is what the server sees, not an IP.
        // hyper writes header names lower-case on the wire.
        assert!(
            head.to_lowercase().contains(&format!("host: llm-host:{port}")),
            "the Host header was rewritten: {head}"
        );
        // Path and query survive untouched.
        assert!(head.starts_with("GET /v1/models HTTP/1.1"), "{head}");

        let diag = resolver::shared().peek("llm-host", port).unwrap();
        assert!(diag.suppressed_public);
        assert_eq!(diag.selected().map(|a| a.ip()), Some(ip("127.0.0.1")));
        assert_eq!(
            response.peer.as_deref(),
            Some(&*format!("127.0.0.1:{port}"))
        );
    }

    #[tokio::test]
    async fn a_refused_address_falls_through_to_the_next_eligible_one() {
        let (port, requests) = serve(OK_JSON, 1);
        // The server binds IPv4 only, so the IPv6 loopback refuses at once --
        // a real connection refusal, not a blackholed address.
        let _guard = pin(vec![ip("::1"), ip("127.0.0.1")]);

        let response = send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/models"),
            method: "GET".into(),
            headers: HashMap::new(),
            body: None,
            timeout_secs: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert!(requests
            .recv()
            .unwrap()
            .to_lowercase()
            .contains("host: llm-host"));
    }

    #[tokio::test]
    async fn a_real_403_from_the_selected_server_is_reported_as_a_403() {
        // The failure that started this looked like a permissions problem and
        // was not. Now that the right machine is reached, its own refusal must
        // survive as an HTTP response rather than becoming a transport error.
        const FORBIDDEN: &str =
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 8\r\nConnection: close\r\n\r\nno entry";
        let (port, _requests) = serve(FORBIDDEN, 1);
        let _guard = pin(vec![ip("127.0.0.1")]);

        let response = send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/models"),
            method: "GET".into(),
            headers: HashMap::from([("Authorization".into(), "Bearer secret-key".into())]),
            body: None,
            timeout_secs: Some(10),
            ..Default::default()
        })
        .await
        .expect("a 403 is a response, not a transport failure");

        assert_eq!(response.status, 403);
        assert_eq!(response.status_text, "Forbidden");
        // And the diagnostics for that endpoint still carry no credential.
        let text = describe("llm-host", port).unwrap();
        assert!(!text.contains("secret-key"), "{text}");
    }

    #[tokio::test]
    async fn a_request_body_and_method_reach_the_server_unchanged() {
        let (port, requests) = serve(OK_JSON, 1);
        let _guard = pin(vec![ip("127.0.0.1")]);

        send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/chat/completions?stream=false"),
            method: "POST".into(),
            headers: HashMap::from([("Content-Type".into(), "application/json".into())]),
            body: Some("{\"model\":\"qwen3.8-27b\"}".into()),
            timeout_secs: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();

        let head = requests.recv().unwrap();
        assert!(
            head.starts_with("POST /v1/chat/completions?stream=false HTTP/1.1"),
            "{head}"
        );
        assert!(head.contains("{\"model\":\"qwen3.8-27b\"}"), "{head}");
    }

    #[tokio::test]
    async fn a_streamed_body_arrives_in_order_and_ends_once() {
        const SSE: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"a\":1}\n\ndata: [DONE]\n\n";
        let (port, _requests) = serve(SSE, 1);
        let _guard = pin(vec![ip("203.0.113.9"), ip("127.0.0.1")]);

        struct Collect(std::sync::Arc<Mutex<Vec<StreamChunk>>>);
        impl ChunkSink for Collect {
            fn send(&self, chunk: StreamChunk) {
                self.0.lock().unwrap().push(chunk);
            }
        }
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        send_stream(
            ProviderRequest {
                url: format!("http://llm-host:{port}/v1/chat/completions"),
                method: "POST".into(),
                headers: HashMap::new(),
                body: Some("{}".into()),
                timeout_secs: Some(10),
                ..Default::default()
            },
            Collect(seen.clone()),
        )
        .await
        .unwrap();

        let chunks = seen.lock().unwrap();
        match &chunks[0] {
            StreamChunk::Head { status, peer, .. } => {
                assert_eq!(*status, 200);
                // Streaming went to the same private address as everything else.
                assert!(peer.as_deref().unwrap().starts_with("127.0.0.1:"));
            }
            other => panic!("the first chunk must be the head, got {other:?}"),
        }
        let body: String = chunks
            .iter()
            .filter_map(|c| match c {
                StreamChunk::Data { b64 } => Some(
                    String::from_utf8(
                        base64::engine::general_purpose::STANDARD
                            .decode(b64)
                            .unwrap(),
                    )
                    .unwrap(),
                ),
                _ => None,
            })
            .collect();
        assert!(body.contains("data: {\"a\":1}"), "{body}");
        assert!(body.contains("[DONE]"), "{body}");
        assert_eq!(
            chunks
                .iter()
                .filter(|c| matches!(c, StreamChunk::End))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn a_transport_failure_drops_the_cached_addresses_so_the_next_try_resolves_again() {
        let _guard = pin(vec![ip("::1")]);
        // Nothing is listening on that port, so the connection is refused.
        let err = send(ProviderRequest {
            url: "http://llm-host:1/v1/models".into(),
            method: "GET".into(),
            headers: HashMap::new(),
            body: None,
            timeout_secs: Some(5),
            ..Default::default()
        })
        .await
        .unwrap_err();

        assert!(err.contains("could not connect"), "{err}");
        // The message says what was tried, which is the point of the diagnostics.
        assert!(err.contains("::1"), "{err}");
        assert!(resolver::shared().peek("llm-host", 1).is_none());
    }

    #[test]
    fn diagnostics_name_the_addresses_and_the_choice_without_any_credential() {
        struct P;
        impl DnsProbe for P {
            fn lookup(&self, _h: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
                Ok(vec![
                    SocketAddr::new("2606:4700::1".parse().unwrap(), port),
                    SocketAddr::new("100.86.12.4".parse().unwrap(), port),
                ])
            }
        }
        let cache = resolver::shared();
        cache.invalidate("diag-host", 8080);
        cache.resolve(&P, "diag-host", 8080).unwrap();
        let text = describe("diag-host", 8080).unwrap();
        assert!(text.contains("100.86.12.4 [tailscale]"), "{text}");
        assert!(text.contains("suppressed"), "{text}");
        assert!(text.contains("selected 100.86.12.4"), "{text}");
        assert!(!text.to_lowercase().contains("bearer"));
        assert!(!text.to_lowercase().contains("authorization"));
    }

    /// Serves `responses` in order, one per connection, reporting each
    /// request head it received.
    fn serve_each(responses: Vec<String>) -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (port, rx)
    }

    fn redirect_to(location: &str) -> String {
        format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\n\
             Content-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    fn with_credentials() -> HashMap<String, String> {
        HashMap::from([
            ("x-api-key".to_string(), "key-that-must-not-travel".to_string()),
            ("X-Subscription".to_string(), "header-that-must-not-travel".to_string()),
        ])
    }

    /// janhq/jan#8208. A redirect to another server carried every header but
    /// `Authorization` there -- API keys in `x-api-key`, custom credentials.
    /// The other server here records whatever reaches it; nothing may.
    #[tokio::test]
    async fn a_redirect_to_another_server_is_refused_and_nothing_is_sent_there() {
        let (elsewhere, reached_elsewhere) = serve_each(vec![OK_JSON.to_string()]);
        let (port, requests) = serve_each(vec![redirect_to(&format!(
            "http://127.0.0.1:{elsewhere}/v1/models"
        ))]);
        let _guard = pin(vec![ip("127.0.0.1")]);

        let err = send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/models"),
            method: "GET".into(),
            headers: with_credentials(),
            timeout_secs: Some(10),
            ..Default::default()
        })
        .await
        .unwrap_err();

        assert!(err.contains("refused to follow a redirect to another server"), "{err}");
        assert!(err.contains(&format!("127.0.0.1:{elsewhere}")), "{err}");
        assert!(!err.contains("must-not-travel"), "{err}");
        // The configured server was asked; the other one never was.
        requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            reached_elsewhere.recv_timeout(Duration::from_millis(500)).is_err(),
            "the request, credentials and all, reached the other server"
        );
    }

    /// The streaming path uses the same client, so the same refusal.
    #[tokio::test]
    async fn a_streamed_request_refuses_the_same_redirect() {
        struct Collect(mpsc::Sender<StreamChunk>);
        impl ChunkSink for Collect {
            fn send(&self, chunk: StreamChunk) {
                let _ = self.0.send(chunk);
            }
        }
        let (elsewhere, reached_elsewhere) = serve_each(vec![OK_JSON.to_string()]);
        let (port, _requests) = serve_each(vec![redirect_to(&format!(
            "http://127.0.0.1:{elsewhere}/v1/chat/completions"
        ))]);
        let _guard = pin(vec![ip("127.0.0.1")]);
        let (tx, chunks) = mpsc::channel();

        let err = send_stream(
            ProviderRequest {
                url: format!("http://llm-host:{port}/v1/chat/completions"),
                method: "POST".into(),
                headers: with_credentials(),
                body: Some("{}".into()),
                timeout_secs: Some(10),
                ..Default::default()
            },
            Collect(tx),
        )
        .await
        .unwrap_err();

        assert!(err.contains("refused to follow a redirect"), "{err}");
        assert!(matches!(chunks.recv().unwrap(), StreamChunk::Error { .. }));
        assert!(reached_elsewhere.recv_timeout(Duration::from_millis(500)).is_err());
    }

    /// A redirect that stays on the same server is still followed.
    #[tokio::test]
    async fn a_redirect_on_the_same_server_is_followed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        // Rebind on the same port with the two answers in order.
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        let responses = vec![
            redirect_to(&format!("http://llm-host:{port}/v1/models-moved")),
            OK_JSON.to_string(),
        ];
        let (tx, requests) = mpsc::channel();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        let _guard = pin(vec![ip("127.0.0.1")]);

        let response = send(ProviderRequest {
            url: format!("http://llm-host:{port}/v1/models"),
            method: "GET".into(),
            headers: with_credentials(),
            timeout_secs: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        requests.recv().unwrap();
        assert!(requests.recv().unwrap().starts_with("GET /v1/models-moved"));
    }

    /// janhq/jan#8208. A gateway that echoes the request in its error body
    /// would put a secret header's value in the UI and the thread; the body is
    /// redacted before it leaves the transport, on both paths.
    #[tokio::test]
    async fn an_error_body_echoing_a_secret_header_comes_back_redacted() {
        let secret = "transport-8208-echoed-secret";
        crate::core::secret_values::register(secret);
        let body = format!("{{\"error\":\"bad key {secret}\"}}");
        let reply = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (port, _requests) = serve_each(vec![reply.clone(), reply]);
        let _guard = pin(vec![ip("127.0.0.1")]);
        let request = || ProviderRequest {
            url: format!("http://llm-host:{port}/v1/chat/completions"),
            method: "POST".into(),
            body: Some("{}".into()),
            timeout_secs: Some(10),
            ..Default::default()
        };

        let whole = send(request()).await.unwrap();
        assert_eq!(whole.status, 401);
        assert!(!whole.body.contains(secret), "{}", whole.body);
        assert!(whole.body.contains("bad key <redacted>"), "{}", whole.body);

        struct Collect(mpsc::Sender<StreamChunk>);
        impl ChunkSink for Collect {
            fn send(&self, chunk: StreamChunk) {
                let _ = self.0.send(chunk);
            }
        }
        let (tx, chunks) = mpsc::channel();
        send_stream(request(), Collect(tx)).await.unwrap();
        let mut streamed = String::new();
        for chunk in chunks.try_iter() {
            if let StreamChunk::Data { b64 } = chunk {
                let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
                streamed.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        assert!(!streamed.contains(secret), "{streamed}");
        assert!(streamed.contains("bad key <redacted>"), "{streamed}");
    }

    #[test]
    fn only_the_same_server_counts_as_the_same_origin() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(same_origin(&u("https://api.x.com/v1"), &u("https://api.x.com/v2")));
        assert!(same_origin(&u("http://api.x.com/v1"), &u("https://api.x.com/v1")));
        assert!(!same_origin(&u("https://api.x.com/v1"), &u("http://api.x.com/v1")));
        assert!(!same_origin(&u("https://api.x.com/v1"), &u("https://evil.com/v1")));
        assert!(!same_origin(&u("https://api.x.com/v1"), &u("https://api.x.com:8443/v1")));
        assert!(!same_origin(&u("http://h:8080/"), &u("https://h:8443/")));
    }
}
