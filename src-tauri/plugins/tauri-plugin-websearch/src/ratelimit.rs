//! Respecting provider rate limits.
//!
//! Every backend is wrapped in [`Gated`]. When a provider answers with a rate
//! limit (HTTP 429/503, a JSON-RPC error that says so, or a hosted result
//! flagged as throttled) the provider's gate closes for a cool-down: the
//! `Retry-After` the provider sent when there is one, otherwise 30 s doubling on
//! each further limit up to 15 min. While it is closed no call reaches the
//! network; each one gets the same short message saying how long to wait, so an
//! agent loop or a retrying model cannot hammer the provider.
//!
//! The gate itself never switches provider. A keyed or self-hosted backend
//! only ever gets the user's queries, so its limit is waited out. The keyless
//! backends (hosted Exa and DuckDuckGo) are wrapped in [`KeylessFallback`]: when
//! one fails or is limited the query goes to the other keyless one, since the
//! user picked "no key" rather than a vendor.
//!
//! Errors leaving the gate are sanitised: provider name, status and wait time,
//! never a raw response body, an API-key URL or an `Authorization` hint, which
//! a model would otherwise read as instructions.

use crate::provider::{FetchedPage, ImageResult, SearchProvider, SearchResult};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// First cool-down when the provider gave no `Retry-After`.
pub const BASE_COOLDOWN: Duration = Duration::from_secs(30);
/// Longest cool-down the backoff grows to.
pub const MAX_COOLDOWN: Duration = Duration::from_secs(15 * 60);
/// How long a reopened gate must stay quiet before earlier strikes are forgotten.
pub const STRIKE_DECAY: Duration = Duration::from_secs(10 * 60);
/// Longest `Retry-After` honoured; a larger value is clamped to this.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(60 * 60);

/// Prefix every gate message starts with. The frontend keys on the error
/// `kind`, not this text, but tests and callers can match it.
pub const RATE_LIMITED_PREFIX: &str = "Web search is rate limited right now";

const MARKER: &str = " rate limited (";

/// Time source, injectable so tests can move time without sleeping.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[derive(Debug, Clone, Copy)]
struct GateState {
    open_until: Instant,
    /// Consecutive limits without a success in between.
    strikes: u32,
}

/// Per-provider cool-downs, kept in process memory.
pub struct RateGate {
    clock: Arc<dyn Clock>,
    state: Mutex<HashMap<String, GateState>>,
}

impl RateGate {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Time left before `key` may be called again, if its gate is closed.
    pub fn wait_left(&self, key: &str) -> Option<Duration> {
        let now = self.clock.now();
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .get(key)
            .and_then(|s| s.open_until.checked_duration_since(now))
            .filter(|d| !d.is_zero())
    }

    /// Record a limit and return the cool-down applied.
    pub fn record_limit(&self, key: &str, retry_after: Option<Duration>) -> Duration {
        let now = self.clock.now();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = state.entry(key.to_string()).or_insert(GateState {
            open_until: now,
            strikes: 0,
        });
        if let Some(left) = entry.open_until.checked_duration_since(now).filter(|d| !d.is_zero()) {
            // Parallel calls that were already in flight when the gate closed
            // report the same limit; counting each as a new strike would turn
            // one burst into a 2-minute wait.
            if retry_after.is_none() {
                return left;
            }
        } else if now.saturating_duration_since(entry.open_until) >= STRIKE_DECAY {
            // A limit long ago (before the machine slept, say) says nothing
            // about now: start over at the base cool-down.
            entry.strikes = 0;
        }
        entry.strikes = entry.strikes.saturating_add(1);
        let cooldown = match retry_after {
            Some(d) => d.min(MAX_RETRY_AFTER),
            None => backoff(entry.strikes),
        };
        entry.open_until = now + cooldown;
        cooldown
    }

    /// A call went through: forget earlier limits.
    pub fn record_success(&self, key: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.remove(key);
    }
}

/// Cool-down for the `strikes`-th limit in a row: 30 s, 1 m, 2 m, ... 15 m.
pub fn backoff(strikes: u32) -> Duration {
    let shift = strikes.saturating_sub(1).min(16);
    BASE_COOLDOWN
        .saturating_mul(1u32 << shift)
        .min(MAX_COOLDOWN)
}

/// The gate shared by every call in this process.
pub fn global_gate() -> Arc<RateGate> {
    static GATE: OnceLock<Arc<RateGate>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(RateGate::new(Arc::new(SystemClock))))
        .clone()
}

/// Parse a `Retry-After` value: delay seconds, or an HTTP-date relative to
/// `now`. A date in the past means zero.
pub fn parse_retry_after(value: &str, now: SystemTime) -> Option<Duration> {
    let value = value.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(at.duration_since(now).unwrap_or(Duration::ZERO))
}

/// `Retry-After` of a provider response, resolved to a delay.
pub(crate) fn retry_after_of(resp: &reqwest::Response) -> Option<Duration> {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_retry_after(v, SystemTime::now()))
}

/// Whether provider text reports a rate limit.
pub fn mentions_rate_limit(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("rate limit")
        || t.contains("rate-limit")
        || t.contains("ratelimit")
        || t.contains("too many requests")
        || t.contains("quota exceeded")
}

/// The internal error a backend returns for a limit. [`Gated`] turns it into
/// the user-facing message; nothing of the response body is kept.
pub(crate) fn rate_limited_marker(
    provider: &str,
    status: Option<u16>,
    retry_after: Option<Duration>,
) -> String {
    let status = status.map_or("rate limit in response".to_string(), |s| {
        format!("HTTP {s}")
    });
    match retry_after {
        Some(d) => format!("{provider}{MARKER}{status}; retry after {}s)", d.as_secs()),
        None => format!("{provider}{MARKER}{status})"),
    }
}

/// Error for a non-success response from a provider's API. 429 and 503 (and
/// a body that says it is a limit) become a rate-limit marker; anything else
/// keeps the status and at most a short plain-text reason.
pub(crate) fn api_http_error(
    provider: &str,
    status: u16,
    retry_after: Option<Duration>,
    body: &str,
) -> String {
    if status == 429 || status == 503 || mentions_rate_limit(body) {
        return rate_limited_marker(provider, Some(status), retry_after);
    }
    let reason = plain_snippet(body);
    if reason.is_empty() {
        format!("{provider} failed with HTTP {status}")
    } else {
        format!("{provider} failed with HTTP {status}: {reason}")
    }
}

/// A short, plain reason from a provider body: empty for JSON or HTML bodies,
/// otherwise its first line, sanitised and clipped.
pub(crate) fn plain_snippet(body: &str) -> String {
    let body = body.trim();
    if body.starts_with('{') || body.starts_with('[') || body.starts_with('<') {
        return String::new();
    }
    let line = body.lines().next().unwrap_or("");
    let clean = sanitize_error(line);
    clean
        .chars()
        .take(200)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Remove what must never reach a model from an error: JSON bodies, bearer
/// tokens or hints, and URLs that carry a key.
pub fn sanitize_error(msg: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut skip_next = false;
    for word in msg.split(' ') {
        if skip_next {
            skip_next = false;
            continue;
        }
        let lower = word.to_ascii_lowercase();
        if lower == "bearer" {
            skip_next = true;
            continue;
        }
        if lower.starts_with("authorization:") {
            continue;
        }
        if (lower.contains("://") || lower.contains('?'))
            && ["key=", "apikey", "api_key", "token=", "secret"]
                .iter()
                .any(|k| lower.contains(k))
        {
            out.push("(link removed)".to_string());
            continue;
        }
        out.push(word.to_string());
    }
    let joined = out.join(" ");
    // Cut an embedded JSON body.
    match joined.find('{') {
        Some(i) => joined[..i]
            .trim_end()
            .trim_end_matches(':')
            .trim_end()
            .to_string(),
        None => joined,
    }
}

/// Seconds named by a rate-limit marker's `retry after Ns`, if any.
fn marker_retry_after(err: &str) -> Option<Duration> {
    let rest = err.split("retry after ").nth(1)?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().map(Duration::from_secs)
}

fn marker_status(err: &str) -> Option<String> {
    let rest = err.split(MARKER).nth(1)?;
    let end = rest.find([';', ')']).unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

fn is_rate_limit_error(err: &str) -> bool {
    err.contains(MARKER) || mentions_rate_limit(err)
}

fn describe_wait(d: Duration) -> String {
    let secs = d.as_secs().max(1);
    if secs < 90 {
        format!("about {secs} seconds")
    } else {
        format!("about {} minutes", secs.div_ceil(60))
    }
}

/// A backend behind its provider's rate-limit gate.
pub struct Gated {
    name: &'static str,
    key: String,
    keyless_default: bool,
    inner: Box<dyn SearchProvider>,
    gate: Arc<RateGate>,
}

impl Gated {
    pub fn new(
        name: &'static str,
        key: String,
        keyless_default: bool,
        inner: Box<dyn SearchProvider>,
        gate: Arc<RateGate>,
    ) -> Self {
        Self {
            name,
            key,
            keyless_default,
            inner,
            gate,
        }
    }

    fn limited_message(&self, status: Option<&str>, wait: Duration) -> String {
        let what = match status {
            Some(s) => format!("{}, {s}", self.name),
            None => self.name.to_string(),
        };
        let mut msg = format!(
            "{RATE_LIMITED_PREFIX} ({what}); the next attempt is allowed in {}. \
             Do not retry before then; answer from what you already know or tell the user.",
            describe_wait(wait)
        );
        if self.keyless_default {
            msg.push_str(" Add a search provider key in Settings > Web Search for unlimited use.");
        }
        msg
    }

    fn check(&self) -> Result<(), String> {
        match self.gate.wait_left(&self.key) {
            Some(wait) => Err(self.limited_message(None, wait)),
            None => Ok(()),
        }
    }

    fn settle<T>(&self, result: Result<T, String>) -> Result<T, String> {
        match result {
            Ok(v) => {
                self.gate.record_success(&self.key);
                Ok(v)
            }
            Err(e) if is_rate_limit_error(&e) => {
                let wait = self.gate.record_limit(&self.key, marker_retry_after(&e));
                Err(self.limited_message(marker_status(&e).as_deref(), wait))
            }
            Err(e) => Err(sanitize_error(&e)),
        }
    }
}

#[async_trait]
impl SearchProvider for Gated {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        self.check()?;
        let r = self.inner.search(query, count).await;
        self.settle(r)
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        self.check()?;
        let r = self.inner.fetch(url).await;
        self.settle(r)
    }

    async fn search_images(&self, query: &str, count: u32) -> Result<Vec<ImageResult>, String> {
        self.check()?;
        let r = self.inner.search_images(query, count).await;
        self.settle(r)
    }
}

/// The two keyless backends: a failed or limited `primary` hands the call to
/// `secondary`. When both fail the primary's error is returned, since it names
/// the provider the user sees in Settings.
pub struct KeylessFallback {
    pub primary: Box<dyn SearchProvider>,
    pub secondary: Box<dyn SearchProvider>,
}

#[async_trait]
impl SearchProvider for KeylessFallback {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        match self.primary.search(query, count).await {
            Ok(v) => Ok(v),
            Err(e) => self.secondary.search(query, count).await.map_err(|_| e),
        }
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        match self.primary.fetch(url).await {
            Ok(v) => Ok(v),
            Err(e) => self.secondary.fetch(url).await.map_err(|_| e),
        }
    }

    async fn search_images(&self, query: &str, count: u32) -> Result<Vec<ImageResult>, String> {
        match self.primary.search_images(query, count).await {
            Ok(v) => Ok(v),
            Err(e) => self.secondary.search_images(query, count).await.map_err(|_| e),
        }
    }
}

/// Whether an error message came from the rate-limit gate.
pub fn is_gate_message(msg: &str) -> bool {
    msg.starts_with(RATE_LIMITED_PREFIX)
}

#[cfg(test)]
mod tests;

/// The user's ordered search chain (Settings > Web Search): each entry is tried
/// in turn and a failed or limited one hands the call to the next. When every
/// entry fails the first entry's error is returned, since it names the provider
/// the user put on top.
pub struct Chain {
    pub entries: Vec<Box<dyn SearchProvider>>,
}

impl Chain {
    async fn first_ok<'a, T, F, Fut>(&'a self, call: F) -> Result<T, String>
    where
        F: Fn(&'a dyn SearchProvider) -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let mut first_err: Option<String> = None;
        for entry in &self.entries {
            match call(entry.as_ref()).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
        Err(first_err.unwrap_or_else(|| "No web search provider is enabled.".to_string()))
    }
}

#[async_trait]
impl SearchProvider for Chain {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        self.first_ok(|p| p.search(query, count)).await
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        self.first_ok(|p| p.fetch(url)).await
    }

    async fn search_images(&self, query: &str, count: u32) -> Result<Vec<ImageResult>, String> {
        self.first_ok(|p| p.search_images(query, count)).await
    }
}
