//! Native, provider-neutral web search backend.
//!
//! The `web_search` / `web_fetch` capability is defined by the [`SearchProvider`]
//! trait; concrete backends implement it and are selected at call time by
//! [`create_provider`]. Adding a backend is a new impl plus one match arm - the
//! plugin command contract and the whole frontend stay unchanged.
//!
//! [`ExaProvider`] is the default. Exa is a backend, never a product-facing
//! identity:
//!
//! * Keyless (default): Exa's hosted endpoint at `https://mcp.exa.ai/mcp`
//!   answers over JSON-RPC with no API key.
//! * Keyed (opt-in): when an Exa API key is supplied the structured REST API
//!   (`https://api.exa.ai`) is used instead, for normalized JSON and higher
//!   rate limits.
//!
//! Every backend normalizes into [`SearchResult`] / [`FetchedPage`] and bounds
//! output size so tool results can't blow up the model's context.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const FETCH_MAX_CHARS: usize = 40_000;
/// Hard cap on the bytes read from any response body (Jozkah/jan#182). The
/// body is read chunk by chunk and reading stops here, so a huge or endless
/// response never has to fit in memory before the character bound applies.
/// 4 MiB leaves room for a 40k-character page in any encoding plus markup,
/// and for every provider's JSON result list.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub const SEARCH_DEFAULT_COUNT: u32 = 5;
pub const SEARCH_MAX_COUNT: u32 = 20;
const REQUEST_TIMEOUT_SECS: u64 = 30;

const EXA_HOSTED_URL: &str = "https://mcp.exa.ai/mcp";
const EXA_REST_SEARCH_URL: &str = "https://api.exa.ai/search";
const EXA_REST_CONTENTS_URL: &str = "https://api.exa.ai/contents";

const TAVILY_SEARCH_URL: &str = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL: &str = "https://api.tavily.com/extract";

const BRAVE_SEARCH_URL: &str = "https://api.search.brave.com/res/v1/web/search";
const SERPER_SEARCH_URL: &str = "https://google.serper.dev/search";

// DuckDuckGo has no search API. Its HTML results page is what its own lite
// clients and every open-source integration read; it answers browsers, and
// answers anything that does not look like one with a bot check.
const DUCKDUCKGO_HTML_URL: &str = "https://html.duckduckgo.com/html/";
const DUCKDUCKGO_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const YOU_COM_HOSTED_URL: &str = "https://api.you.com/mcp?profile=free";
// Identifies the calling application to You.com, per the convention its other
// integrations follow. Carries no user or query data beyond the request itself,
// and is sent only on requests to You.com.
const YOU_COM_USER_AGENT: &str = concat!(
    "jan-websearch/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/Jozkah/flint)"
);
const YOU_COM_CLIENT_INFO: &str = concat!(
    "plugin; client=jan-websearch/",
    env!("CARGO_PKG_VERSION"),
    "; ua=rust/unknown"
);
const YOU_COM_SEARCH_URL: &str = "https://ydc-index.io/v1/search";
const YOU_COM_CONTENTS_URL: &str = "https://ydc-index.io/v1/contents";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FetchedPage {
    pub url: String,
    pub title: String,
    pub content: String,
    pub truncated: bool,
}

/// A pluggable web search backend. Implementors turn a query into normalized
/// [`SearchResult`]s and a URL into a bounded [`FetchedPage`].
#[async_trait]
pub trait SearchProvider: Send + Sync {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String>;
    async fn fetch(&self, url: &str) -> Result<FetchedPage, String>;
}

/// Build the backend for `provider` (case-insensitive; empty/absent selects the
/// default). `api_key` is used by keyed backends; `endpoint` by self-hosted ones
/// (e.g. a SearXNG instance URL).
pub fn create_provider(
    provider: Option<&str>,
    api_key: Option<String>,
    endpoint: Option<String>,
) -> Result<Box<dyn SearchProvider>, String> {
    match provider.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        None | Some("") | Some("exa") => Ok(Box::new(ExaProvider::new(api_key)?)),
        Some("tavily") => Ok(Box::new(TavilyProvider::new(api_key)?)),
        Some("brave") => Ok(Box::new(BraveProvider::new(api_key)?)),
        // "google" is the user-facing name for the Serper-backed Google adapter.
        Some("serper") | Some("google") => Ok(Box::new(SerperProvider::new(api_key)?)),
        Some("searxng") => Ok(Box::new(SearxngProvider::new(endpoint)?)),
        Some("you") => Ok(Box::new(YouComProvider::new(api_key)?)),
        Some("duckduckgo") | Some("ddg") => Ok(Box::new(DuckDuckGoProvider::new()?)),
        Some(other) => Err(format!("Unknown web search provider '{other}'")),
    }
}

fn require_key(provider: &str, api_key: Option<String>) -> Result<String, String> {
    normalize_key(api_key).ok_or_else(|| {
        // Actionable rather than bare: it names where to fix the missing key and
        // points at the keyless providers, so the caller has a way forward. It
        // does NOT silently reroute the query to a different provider -- the
        // configured provider is the user's choice, and sending their search to
        // another third party without asking would bypass that configuration.
        format!(
            "{provider} requires an API key, and none is configured. Add one in \
             Settings > Web Search (the key for {provider}), or switch the Web Search \
             provider to Exa or You.com, which work with no API key."
        )
    })
}

fn build_http_client(provider: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("failed to build HTTP client for {provider}: {e}"))
}

// -- fetching pages from this machine (Jozkah/jan#189) ------------------------
//
// SearXNG, Brave, Serper and keyless You.com fetch a page by GETting it from
// the user's machine, and `web_fetch` runs without an approval prompt. So the
// URL is model-chosen and must not reach this machine, the LAN or a cloud
// metadata endpoint. Three layers: the URL's own host is checked when it is an
// address; every name the client resolves (the first hop, each redirect, and
// again at connect time, so a rebinding DNS answer gains nothing) keeps only
// public addresses; and each redirect is checked the same way before it is
// followed. The provider's own API client is separate, so a self-hosted
// SearXNG search endpoint on localhost keeps working.

/// Whether `ip` is an ordinary internet address: not loopback, private,
/// link-local, CGNAT, unique-local, unspecified, multicast, broadcast,
/// documentation or reserved, and not one of those wrapped in IPv6.
pub(crate) fn is_public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b)) // CGNAT 100.64/10
                || (a == 192 && b == 0 && c == 0) // IETF 192.0.0/24
                || (a == 198 && (b == 18 || b == 19)) // benchmarking 198.18/15
                || a >= 240) // reserved 240/4
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            // NAT64 (64:ff9b::/96) carries an IPv4 address in its low bits.
            if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
                let [.., hi, lo] = seg;
                let v4 = std::net::Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
                return is_public_ip(IpAddr::V4(v4));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (seg[0] & 0xffc0) == 0xfe80 // link local fe80::/10
                || (seg[0] == 0x2001 && seg[1] == 0x0db8)) // documentation
        }
    }
}

/// Refuse a URL whose host is written as a non-public address or is a name
/// for this machine. Names are left to [`PublicOnlyResolver`].
pub(crate) fn check_public_url(url: &reqwest::Url) -> Result<(), String> {
    match url.host() {
        Some(url::Host::Ipv4(ip)) if !is_public_ip(ip.into()) => {
            Err(format!("refused to fetch {url}: {ip} is a local or private address"))
        }
        Some(url::Host::Ipv6(ip)) if !is_public_ip(ip.into()) => {
            Err(format!("refused to fetch {url}: {ip} is a local or private address"))
        }
        Some(url::Host::Domain(d))
            if d.eq_ignore_ascii_case("localhost")
                || d.to_ascii_lowercase().ends_with(".localhost") =>
        {
            Err(format!("refused to fetch {url}: {d} is this machine"))
        }
        None => Err(format!("refused to fetch {url}: no host")),
        _ => Ok(()),
    }
}

/// Resolves a name to its public addresses only; a name with none is an error.
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let public: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|a| is_public_ip(a.ip()))
                .collect();
            if public.is_empty() {
                return Err(format!("{host} resolves only to local or private addresses").into());
            }
            Ok(Box::new(public.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The one client pages are fetched with, built once.
fn public_fetch_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .dns_resolver(std::sync::Arc::new(PublicOnlyResolver))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 10 {
                        return attempt.error("too many redirects");
                    }
                    match check_public_url(attempt.url()) {
                        Ok(()) => attempt.follow(),
                        Err(e) => attempt.error(e),
                    }
                }))
                .build()
                .map_err(|e| format!("failed to build the page-fetch HTTP client: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// GET `url` from this machine, refusing anything that is not a public
/// internet address.
async fn public_get(url: &str, provider: &str) -> Result<reqwest::Response, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("{provider} fetch: invalid URL: {e}"))?;
    check_public_url(&parsed)?;
    public_fetch_client()?
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("{provider} fetch request failed: {e}"))
}

/// Which Exa transport the adapter uses.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ExaMode {
    Hosted,
    Rest(String),
}

fn normalize_key(api_key: Option<String>) -> Option<String> {
    api_key.and_then(|v| {
        let v = v.trim().to_string();
        if v.is_empty() || v == "YOUR_EXA_API_KEY_HERE" {
            None
        } else {
            Some(v)
        }
    })
}

/// Exa backend. Defaults to the keyless hosted endpoint; upgrades to the
/// structured REST API when a key is supplied.
pub struct ExaProvider {
    mode: ExaMode,
    client: reqwest::Client,
}

impl ExaProvider {
    pub fn new(api_key: Option<String>) -> Result<Self, String> {
        let mode = match normalize_key(api_key) {
            Some(key) => ExaMode::Rest(key),
            None => ExaMode::Hosted,
        };
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("failed to build HTTP client for Exa: {e}"))?;
        Ok(Self { mode, client })
    }

    async fn hosted_call(&self, tool: &str, arguments: Value) -> Result<String, String> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments }
        });
        let resp = self
            .client
            .post(EXA_HOSTED_URL)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Exa request failed: {e}"))?;
        let status = resp.status();
        let text = read_body_capped(resp, MAX_RESPONSE_BYTES)
            .await
            .map_err(|e| format!("Exa: failed to read response body: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "Exa failed with HTTP {}: {}",
                status.as_u16(),
                text.chars().take(400).collect::<String>()
            ));
        }
        parse_hosted_result_text(&text, "Exa")
    }
}

#[async_trait]
impl SearchProvider for ExaProvider {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        match &self.mode {
            ExaMode::Hosted => {
                let text = self
                    .hosted_call(
                        "web_search_exa",
                        json!({ "query": query, "numResults": count }),
                    )
                    .await?;
                Ok(parse_hosted_search_text(&text))
            }
            ExaMode::Rest(key) => {
                let body = json!({
                    "query": query,
                    "type": "auto",
                    "numResults": count,
                    "contents": {
                        "text": { "maxCharacters": 800 },
                        "highlights": { "numSentences": 3, "highlightsPerUrl": 1 }
                    }
                });
                let resp = self
                    .client
                    .post(EXA_REST_SEARCH_URL)
                    .header("x-api-key", key)
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("Exa search request failed: {e}"))?;
                let status = resp.status();
                let text = read_body_capped(resp, MAX_RESPONSE_BYTES)
                    .await
                    .map_err(|e| format!("Exa search: failed to read response body: {e}"))?;
                if !status.is_success() {
                    return Err(format!(
                        "Exa search failed with HTTP {}: {}",
                        status.as_u16(),
                        text.chars().take(400).collect::<String>()
                    ));
                }
                let parsed: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("Exa search: invalid JSON response: {e}"))?;
                Ok(normalize_exa_rest_search(&parsed))
            }
        }
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        match &self.mode {
            ExaMode::Hosted => {
                let text = self
                    .hosted_call(
                        "web_fetch_exa",
                        json!({ "urls": [url], "maxCharacters": FETCH_MAX_CHARS }),
                    )
                    .await?;
                Ok(parse_hosted_fetch_text(&text, url))
            }
            ExaMode::Rest(key) => {
                let body = json!({ "ids": [url], "text": true });
                let resp = self
                    .client
                    .post(EXA_REST_CONTENTS_URL)
                    .header("x-api-key", key)
                    .header("content-type", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("Exa fetch request failed: {e}"))?;
                let status = resp.status();
                let text = read_body_capped(resp, MAX_RESPONSE_BYTES)
                    .await
                    .map_err(|e| format!("Exa fetch: failed to read response body: {e}"))?;
                if !status.is_success() {
                    return Err(format!(
                        "Exa fetch failed with HTTP {}: {}",
                        status.as_u16(),
                        text.chars().take(400).collect::<String>()
                    ));
                }
                let parsed: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("Exa fetch: invalid JSON response: {e}"))?;
                normalize_exa_rest_fetch(&parsed, url)
            }
        }
    }
}

/// Pull the tool payload out of an MCP `tools/call` response. Streamable HTTP
/// answers with either a bare JSON-RPC object or an SSE stream, and a stream may
/// carry progress notifications ahead of the answer, so the frame holding
/// `result` or `error` is the one to read.
fn parse_hosted_result_text(body: &str, provider: &str) -> Result<String, String> {
    let envelope = match body
        .lines()
        .filter_map(|l| l.strip_prefix("data:").map(str::trim))
        .filter_map(|frame| serde_json::from_str::<Value>(frame).ok())
        .find(|v| v.get("result").is_some() || v.get("error").is_some())
    {
        Some(frame) => frame,
        None => serde_json::from_str::<Value>(body.trim())
            .map_err(|e| format!("{provider}: invalid response payload: {e}"))?,
    };
    if let Some(err) = envelope.get("error") {
        return Err(format!("{provider} returned an error: {err}"));
    }
    let result = envelope
        .get("result")
        .ok_or_else(|| format!("{provider} response missing 'result'"))?;
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("text"))
        .and_then(|v| v.as_str());
    // A throttled hosted endpoint answers HTTP 200 with no `isError`, putting
    // the refusal in the text block where it parses as zero results. Reported
    // as success that reads to a model as "the web has nothing", so the flag in
    // `_meta` is the only thing separating a refusal from a real empty answer.
    if is_rate_limited(result) {
        return Err(format!(
            "{provider} rate limit reached: {}",
            text.unwrap_or("no quota remaining on the keyless endpoint")
        ));
    }
    if result.get("isError").and_then(|v| v.as_bool()) == Some(true) {
        return Err(format!(
            "{provider} tool call failed: {}",
            text.unwrap_or("unknown error")
        ));
    }
    text.map(str::to_string)
        .ok_or_else(|| format!("{provider} response had no text content"))
}

/// Whether a hosted `result` carries a provider rate-limit marker in `_meta`.
///
/// Namespaced per vendor (`ai.exa/rateLimited`), so the suffix is matched
/// rather than one hard-coded key: the hosted transport is shared by every
/// keyless backend here.
fn is_rate_limited(result: &Value) -> bool {
    result
        .get("_meta")
        .and_then(|m| m.as_object())
        .is_some_and(|meta| {
            meta.iter().any(|(k, v)| {
                (k == "rateLimited" || k.ends_with("/rateLimited")) && v.as_bool() == Some(true)
            })
        })
}

fn parse_hosted_search_text(text: &str) -> Vec<SearchResult> {
    let mut out = Vec::new();
    for block in text.split("\n---\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let mut title = String::new();
        let mut url = String::new();
        let mut published: Option<String> = None;
        let mut in_highlights = false;
        let mut snippet_lines: Vec<String> = Vec::new();
        for line in block.lines() {
            let trimmed = line.trim();
            if let Some(v) = trimmed.strip_prefix("Title:") {
                title = v.trim().to_string();
            } else if let Some(v) = trimmed.strip_prefix("URL:") {
                url = v.trim().to_string();
            } else if let Some(v) = trimmed.strip_prefix("Published:") {
                let v = v.trim();
                if !v.is_empty() && v != "N/A" {
                    published = Some(v.to_string());
                }
            } else if trimmed.starts_with("Author:") {
                // Ignored in the normalized contract.
            } else if trimmed.starts_with("Highlights:") {
                in_highlights = true;
            } else if in_highlights && trimmed != "..." && !trimmed.is_empty() {
                snippet_lines.push(trimmed.to_string());
            }
        }
        if url.is_empty() && title.is_empty() {
            continue;
        }
        let snippet = clip_chars(&snippet_lines.join(" "), 500);
        out.push(SearchResult {
            title,
            url,
            snippet,
            published_at: published,
        });
    }
    out
}

fn parse_hosted_fetch_text(text: &str, requested_url: &str) -> FetchedPage {
    let mut title = String::new();
    let mut url = requested_url.to_string();
    let mut body_start = 0usize;
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if i == 0 && trimmed.starts_with("# ") {
            title = trimmed[2..].trim().to_string();
        } else if let Some(v) = trimmed.strip_prefix("URL:") {
            url = v.trim().to_string();
            body_start = i + 1;
            break;
        } else if i > 2 {
            break;
        }
    }
    let body: String = text
        .lines()
        .skip(body_start)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    let source = if body.is_empty() { text.trim() } else { &body };
    let (content, truncated) = bound_text(source);
    FetchedPage {
        url,
        title,
        content,
        truncated,
    }
}

fn normalize_exa_rest_search(body: &Value) -> Vec<SearchResult> {
    let Some(results) = body.get("results").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    results
        .iter()
        .map(|r| {
            let title = r
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let url = r
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let snippet = r
                .get("highlights")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| {
                    r.get("text")
                        .and_then(|v| v.as_str())
                        .map(|t| clip_chars(t, 300))
                })
                .unwrap_or_default();
            let published_at = r
                .get("publishedDate")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            SearchResult {
                title,
                url,
                snippet,
                published_at,
            }
        })
        .collect()
}

fn normalize_exa_rest_fetch(body: &Value, requested_url: &str) -> Result<FetchedPage, String> {
    let first = body
        .get("results")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| format!("Exa fetch returned no content for {requested_url}"))?;
    let url = first
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or(requested_url)
        .to_string();
    let title = first
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let raw = first.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let (content, truncated) = bound_text(raw);
    Ok(FetchedPage {
        url,
        title,
        content,
        truncated,
    })
}

/// Tavily backend (key-only). Uses the structured `/search` and `/extract`
/// REST endpoints, authenticated with a bearer token.
pub struct TavilyProvider {
    api_key: String,
    client: reqwest::Client,
}

impl TavilyProvider {
    pub fn new(api_key: Option<String>) -> Result<Self, String> {
        Ok(Self {
            api_key: require_key("Tavily", api_key)?,
            client: build_http_client("Tavily")?,
        })
    }

    async fn post(&self, url: &str, body: Value) -> Result<Value, String> {
        let resp = self
            .client
            .post(url)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Tavily request failed: {e}"))?;
        let status = resp.status();
        let text = read_body_capped(resp, MAX_RESPONSE_BYTES)
            .await
            .map_err(|e| format!("Tavily: failed to read response body: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "Tavily failed with HTTP {}: {}",
                status.as_u16(),
                text.chars().take(400).collect::<String>()
            ));
        }
        serde_json::from_str(&text).map_err(|e| format!("Tavily: invalid JSON response: {e}"))
    }
}

#[async_trait]
impl SearchProvider for TavilyProvider {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        let parsed = self
            .post(
                TAVILY_SEARCH_URL,
                json!({ "query": query, "max_results": count }),
            )
            .await?;
        Ok(normalize_tavily_search(&parsed))
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        let parsed = self
            .post(TAVILY_EXTRACT_URL, json!({ "urls": [url] }))
            .await?;
        normalize_tavily_extract(&parsed, url)
    }
}

fn normalize_tavily_search(body: &Value) -> Vec<SearchResult> {
    let Some(results) = body.get("results").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    results
        .iter()
        .map(|r| {
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let snippet = r
                .get("content")
                .and_then(|v| v.as_str())
                .map(|t| clip_chars(t, 500))
                .unwrap_or_default();
            let published_at = r
                .get("published_date")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            SearchResult {
                title: title.to_string(),
                url: url.to_string(),
                snippet,
                published_at,
            }
        })
        .collect()
}

fn normalize_tavily_extract(body: &Value, requested_url: &str) -> Result<FetchedPage, String> {
    let first = body
        .get("results")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| format!("Tavily returned no content for {requested_url}"))?;
    let url = first
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or(requested_url)
        .to_string();
    let raw = first
        .get("raw_content")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let (content, truncated) = bound_text(raw);
    Ok(FetchedPage {
        url,
        title: String::new(),
        content,
        truncated,
    })
}

/// Attach the shared You.com request headers. Callers set the body with
/// `.json()`, which already sets `Content-Type: application/json` — setting it
/// again here would duplicate the header (reqwest's `.header()` appends), and
/// api.you.com rejects a multi-valued `Content-Type` with HTTP 415.
fn with_youcom_headers(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request
        .header("user-agent", YOU_COM_USER_AGENT)
        .header("x-client-info", YOU_COM_CLIENT_INFO)
}

/// Which You.com transport the adapter uses.
#[derive(Debug, Clone, PartialEq, Eq)]
enum YouComMode {
    Hosted,
    Rest(String),
}

/// You.com backend. Defaults to the keyless hosted endpoint; upgrades to the
/// structured REST API when a key is supplied.
///
/// * Keyless (default): the hosted MCP endpoint answers `you-search` with no
///   credentials. `web_fetch` has no keyless counterpart, so it falls back to a
///   direct GET, the same way [`SearxngProvider`] handles a backend with no
///   extraction endpoint.
/// * Keyed (opt-in): the structured REST API at `https://ydc-index.io`, which
///   adds `/v1/contents` for real content extraction and lifts the free tier's
///   request cap.
///
/// Both transports return the same search payload, so one normalizer serves
/// both.
pub struct YouComProvider {
    mode: YouComMode,
    client: reqwest::Client,
}

impl YouComProvider {
    pub fn new(api_key: Option<String>) -> Result<Self, String> {
        let mode = match normalize_key(api_key) {
            Some(key) => YouComMode::Rest(key),
            None => YouComMode::Hosted,
        };
        Ok(Self {
            mode,
            client: build_http_client("You.com")?,
        })
    }

    /// Send a prepared request and return the body, mapping transport and HTTP
    /// failures into one message shape for both transports.
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<String, String> {
        let resp = with_youcom_headers(request)
            .send()
            .await
            .map_err(|e| format!("You.com request failed: {e}"))?;
        let status = resp.status();
        let text = read_body_capped(resp, MAX_RESPONSE_BYTES)
            .await
            .map_err(|e| format!("You.com: failed to read response body: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "You.com failed with HTTP {}: {}",
                status.as_u16(),
                text.chars().take(400).collect::<String>()
            ));
        }
        Ok(text)
    }

    /// Keyed transport: plain JSON POST authenticated with `X-API-Key`.
    async fn post_rest(&self, url: &str, key: &str, body: Value) -> Result<Value, String> {
        let text = self
            .send(self.client.post(url).header("X-API-Key", key).json(&body))
            .await?;
        serde_json::from_str(&text).map_err(|e| format!("You.com: invalid JSON response: {e}"))
    }

    /// Keyless transport: one MCP `tools/call` for `you-search`, the only tool
    /// the free profile exposes. The tool payload is the same JSON the REST
    /// endpoint returns, so the caller can hand it to the same normalizer.
    async fn hosted_search(&self, arguments: Value) -> Result<Value, String> {
        let text = self
            .send(
                self.client
                    .post(YOU_COM_HOSTED_URL)
                    .header("accept", "application/json, text/event-stream")
                    .json(&json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": { "name": "you-search", "arguments": arguments }
                    })),
            )
            .await?;
        let payload = parse_hosted_result_text(&text, "You.com")?;
        serde_json::from_str(&payload)
            .map_err(|e| format!("You.com: invalid JSON in tool result: {e}"))
    }
}

#[async_trait]
impl SearchProvider for YouComProvider {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        let args = json!({ "query": query, "count": count });
        let parsed = match &self.mode {
            YouComMode::Hosted => self.hosted_search(args).await?,
            YouComMode::Rest(key) => self.post_rest(YOU_COM_SEARCH_URL, key, args).await?,
        };
        Ok(normalize_youcom_search(&parsed))
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        match &self.mode {
            // No keyless content endpoint, so read the page directly.
            YouComMode::Hosted => fetch_url_direct(&self.client, url, "You.com").await,
            YouComMode::Rest(key) => {
                let parsed = self
                    .post_rest(
                        YOU_COM_CONTENTS_URL,
                        key,
                        json!({ "urls": [url], "formats": ["markdown"] }),
                    )
                    .await?;
                normalize_youcom_contents(&parsed, url)
            }
        }
    }
}

/// `/v1/search` groups results into sections. `web` is the section jan's
/// `web_search` contract maps to, so a response carrying no `web` section
/// (news-only, or empty) yields no results rather than falling back to `news`.
fn normalize_youcom_search(body: &Value) -> Vec<SearchResult> {
    let Some(web) = body
        .get("results")
        .and_then(|r| r.get("web"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };
    web.iter()
        .map(|r| {
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
            // `description` is the whole-result summary; `snippets` are keyword
            // fragments, used only when a result carries no description.
            let snippet = r
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    r.get("snippets")
                        .and_then(|v| v.as_array())
                        .and_then(|a| a.first())
                        .and_then(|v| v.as_str())
                })
                .map(|s| clip_chars(s, 500))
                .unwrap_or_default();
            let published_at = r
                .get("page_age")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            SearchResult {
                title: title.to_string(),
                url: url.to_string(),
                snippet,
                published_at,
            }
        })
        .collect()
}

/// `/v1/contents` answers with a bare array, one entry per requested URL.
/// The request asks for `markdown`, so that is the only content field read.
/// The spec types `markdown` as nullable — null is how the API reports a
/// failed extraction — so a missing or empty `markdown` is an error, not an
/// empty page.
fn normalize_youcom_contents(body: &Value, requested_url: &str) -> Result<FetchedPage, String> {
    let first = body
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| format!("You.com returned no content for {requested_url}"))?;
    let url = first
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or(requested_url)
        .to_string();
    let title = first
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let raw = first
        .get("markdown")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("You.com returned no content for {requested_url}"))?;
    let (content, truncated) = bound_text(raw);
    Ok(FetchedPage {
        url,
        title,
        content,
        truncated,
    })
}

/// SearXNG backend (self-hosted, key-less). Queries a user-supplied instance's
/// JSON search API. SearXNG has no content-extraction endpoint, so `fetch` does
/// a plain HTTP GET of the URL and returns the bounded raw response body.
pub struct SearxngProvider {
    base_url: String,
    client: reqwest::Client,
}

impl SearxngProvider {
    pub fn new(endpoint: Option<String>) -> Result<Self, String> {
        let base = endpoint
            .map(|e| e.trim().trim_end_matches('/').to_string())
            .filter(|e| !e.is_empty())
            .ok_or("SearXNG requires an instance URL")?;
        if !(base.starts_with("http://") || base.starts_with("https://")) {
            return Err(format!(
                "SearXNG instance URL must be an http(s) URL, got: {base}"
            ));
        }
        Ok(Self {
            base_url: base,
            client: build_http_client("SearXNG")?,
        })
    }
}

#[async_trait]
impl SearchProvider for SearxngProvider {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        let resp = self
            .client
            .get(format!("{}/search", self.base_url))
            .query(&[("q", query), ("format", "json")])
            .send()
            .await
            .map_err(|e| format!("SearXNG request failed: {e}"))?;
        let status = resp.status();
        let text = read_body_capped(resp, MAX_RESPONSE_BYTES)
            .await
            .map_err(|e| format!("SearXNG: failed to read response body: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "SearXNG failed with HTTP {}: {}",
                status.as_u16(),
                text.chars().take(400).collect::<String>()
            ));
        }
        let parsed: Value = serde_json::from_str(&text).map_err(|e| {
            format!("SearXNG: invalid JSON response (is the JSON API enabled?): {e}")
        })?;
        Ok(normalize_searxng_search(&parsed, count))
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        http_get_page(&self.client, url, "SearXNG").await
    }
}

/// Fetch a page over a plain HTTP GET and return bounded readable content.
///
/// Backends without a dedicated content-extraction endpoint (SearXNG, Brave,
/// Serper) share this: there is nothing provider-specific about pulling a URL
/// and reading its body, so the logic lives once.
async fn http_get_page(
    _client: &reqwest::Client,
    url: &str,
    provider: &str,
) -> Result<FetchedPage, String> {
    let resp = public_get(url, provider).await?;
    let status = resp.status();
    let body = read_body_capped(resp, MAX_RESPONSE_BYTES)
        .await
        .map_err(|e| format!("{provider} fetch: failed to read response body: {e}"))?;
    if !status.is_success() {
        return Err(format!("{provider} fetch failed with HTTP {}", status.as_u16()));
    }
    let title = extract_html_title(&body).unwrap_or_default();
    let (content, truncated) = bound_text(&body);
    Ok(FetchedPage {
        url: url.to_string(),
        title,
        content,
        truncated,
    })
}

/// Brave Search backend (key-only). Uses Brave's Web Search REST API,
/// authenticated with the `X-Subscription-Token` header. Brave has no
/// content-extraction endpoint, so `fetch` does a plain HTTP GET.
pub struct BraveProvider {
    api_key: String,
    client: reqwest::Client,
}

impl BraveProvider {
    pub fn new(api_key: Option<String>) -> Result<Self, String> {
        Ok(Self {
            api_key: require_key("Brave", api_key)?,
            client: build_http_client("Brave")?,
        })
    }
}

#[async_trait]
impl SearchProvider for BraveProvider {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        let resp = self
            .client
            .get(BRAVE_SEARCH_URL)
            .header("X-Subscription-Token", &self.api_key)
            .header("Accept", "application/json")
            .query(&[
                ("q", query.to_string()),
                ("count", count.to_string()),
            ])
            .send()
            .await
            .map_err(|e| format!("Brave request failed: {e}"))?;
        let status = resp.status();
        let text = read_body_capped(resp, MAX_RESPONSE_BYTES)
            .await
            .map_err(|e| format!("Brave: failed to read response body: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "Brave failed with HTTP {}: {}",
                status.as_u16(),
                text.chars().take(400).collect::<String>()
            ));
        }
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Brave: invalid JSON response: {e}"))?;
        Ok(normalize_brave_search(&parsed, count))
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        http_get_page(&self.client, url, "Brave").await
    }
}

fn normalize_brave_search(body: &Value, count: u32) -> Vec<SearchResult> {
    let Some(results) = body
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };
    results
        .iter()
        .take(count as usize)
        .map(|r| {
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let snippet = r
                .get("description")
                .and_then(|v| v.as_str())
                .map(|t| clip_chars(&strip_html_tags(t), 500))
                .unwrap_or_default();
            let published_at = r
                .get("page_age")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            SearchResult {
                title: title.to_string(),
                url: url.to_string(),
                snippet,
                published_at,
            }
        })
        .collect()
}

/// Serper backend (key-only): Google's Search Engine Results via serper.dev.
/// Posts to `/search` with an `X-API-KEY` header. No content-extraction
/// endpoint, so `fetch` does a plain HTTP GET.
pub struct SerperProvider {
    api_key: String,
    client: reqwest::Client,
}

impl SerperProvider {
    pub fn new(api_key: Option<String>) -> Result<Self, String> {
        Ok(Self {
            api_key: require_key("Serper", api_key)?,
            client: build_http_client("Serper")?,
        })
    }
}

#[async_trait]
impl SearchProvider for SerperProvider {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        let resp = self
            .client
            .post(SERPER_SEARCH_URL)
            .header("X-API-KEY", &self.api_key)
            .header("content-type", "application/json")
            .json(&json!({ "q": query, "num": count }))
            .send()
            .await
            .map_err(|e| format!("Serper request failed: {e}"))?;
        let status = resp.status();
        let text = read_body_capped(resp, MAX_RESPONSE_BYTES)
            .await
            .map_err(|e| format!("Serper: failed to read response body: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "Serper failed with HTTP {}: {}",
                status.as_u16(),
                text.chars().take(400).collect::<String>()
            ));
        }
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Serper: invalid JSON response: {e}"))?;
        Ok(normalize_serper_search(&parsed, count))
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        http_get_page(&self.client, url, "Serper").await
    }
}

fn normalize_serper_search(body: &Value, count: u32) -> Vec<SearchResult> {
    let Some(results) = body.get("organic").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    results
        .iter()
        .take(count as usize)
        .map(|r| {
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            // Serper names the result URL `link`.
            let url = r.get("link").and_then(|v| v.as_str()).unwrap_or("");
            let snippet = r
                .get("snippet")
                .and_then(|v| v.as_str())
                .map(|t| clip_chars(t, 500))
                .unwrap_or_default();
            let published_at = r
                .get("date")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            SearchResult {
                title: title.to_string(),
                url: url.to_string(),
                snippet,
                published_at,
            }
        })
        .collect()
}

/// Strip HTML tags from a snippet. Brave marks query terms with `<strong>`;
/// the normalized contract is plain text, so the tags come out.
fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn normalize_searxng_search(body: &Value, count: u32) -> Vec<SearchResult> {
    let Some(results) = body.get("results").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    results
        .iter()
        .take(count as usize)
        .map(|r| {
            let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let snippet = r
                .get("content")
                .and_then(|v| v.as_str())
                .map(|t| clip_chars(t, 500))
                .unwrap_or_default();
            let published_at = r
                .get("publishedDate")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            SearchResult {
                title: title.to_string(),
                url: url.to_string(),
                snippet,
                published_at,
            }
        })
        .collect()
}

/// DuckDuckGo backend (key-less, no setup). Reads the HTML results page
/// (`html.duckduckgo.com/html/`), which lists ten organic results with their
/// real URLs, titles and snippets. There is no content-extraction endpoint, so
/// `fetch` does a plain HTTP GET like SearXNG, Brave and Serper.
///
/// DuckDuckGo may answer a burst of queries with a bot check instead of
/// results; that is reported as an error naming the way out rather than as
/// "no results", so the model does not conclude the web has nothing to say.
pub struct DuckDuckGoProvider {
    client: reqwest::Client,
}

impl DuckDuckGoProvider {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: build_http_client("DuckDuckGo")?,
        })
    }
}

#[async_trait]
impl SearchProvider for DuckDuckGoProvider {
    async fn search(&self, query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
        let resp = self
            .client
            .post(DUCKDUCKGO_HTML_URL)
            .header(reqwest::header::USER_AGENT, DUCKDUCKGO_USER_AGENT)
            .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
            .form(&[("q", query)])
            .send()
            .await
            .map_err(|e| format!("DuckDuckGo request failed: {e}"))?;
        let status = resp.status();
        let html = read_body_capped(resp, MAX_RESPONSE_BYTES)
            .await
            .map_err(|e| format!("DuckDuckGo: failed to read response body: {e}"))?;
        // A bot check can come back as 200 or as 202/403; read the page first.
        if is_duckduckgo_bot_check(&html) {
            return Err(DUCKDUCKGO_BOT_CHECK.to_string());
        }
        if !status.is_success() {
            return Err(format!("DuckDuckGo failed with HTTP {}", status.as_u16()));
        }
        Ok(parse_duckduckgo_results(&html, count))
    }

    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        http_get_page(&self.client, url, "DuckDuckGo").await
    }
}

const DUCKDUCKGO_BOT_CHECK: &str = "DuckDuckGo asked for a bot check instead of returning results, which it does after \
     many searches in a short time. Wait a minute and retry, or switch the Web Search provider \
     in Settings > Web Search to Exa or You.com, which work with no API key.";

fn is_duckduckgo_bot_check(html: &str) -> bool {
    html.contains("anomaly-modal") || html.contains("challenge-form")
}

/// The organic results on a DuckDuckGo HTML results page, in page order, with
/// ads dropped and links resolved to the real destination. A page with no
/// results parses to an empty list.
fn parse_duckduckgo_results(html: &str, count: u32) -> Vec<SearchResult> {
    let mut out: Vec<SearchResult> = Vec::new();
    // Every result is one `<div class="result ...">`; the split leaves that
    // opening tag's class list at the start of each piece.
    for block in html.split("<div class=\"result ").skip(1) {
        if out.len() >= count as usize {
            break;
        }
        let classes = block.split('"').next().unwrap_or("");
        if classes.split_whitespace().any(|c| c == "result--ad") {
            continue;
        }
        let Some(link) = html_anchor_with_class(block, "result__a") else {
            continue;
        };
        let Some(url) = duckduckgo_destination(&link.href) else {
            continue;
        };
        if out.iter().any(|r| r.url == url) {
            continue;
        }
        let title = html_text(&link.inner);
        let snippet = html_anchor_with_class(block, "result__snippet")
            .map(|a| clip_chars(&html_text(&a.inner), 500))
            .unwrap_or_default();
        out.push(SearchResult {
            title: if title.is_empty() { url.clone() } else { title },
            url,
            snippet,
            published_at: None,
        });
    }
    out
}

struct HtmlAnchor {
    href: String,
    inner: String,
}

/// The first `<a ... class="...<class>..." ...>inner</a>` in `html`.
fn html_anchor_with_class(html: &str, class: &str) -> Option<HtmlAnchor> {
    let mut from = 0;
    while let Some(rel) = html[from..].find("<a ") {
        let start = from + rel;
        let tag_end = start + html[start..].find('>')?;
        let tag = &html[start..=tag_end];
        from = tag_end + 1;
        let has_class = html_attr(tag, "class").is_some_and(|c| c.split_whitespace().any(|x| x == class));
        if !has_class {
            continue;
        }
        let close = from + html[from..].find("</a>")?;
        return Some(HtmlAnchor {
            href: html_attr(tag, "href").unwrap_or_default(),
            inner: html[from..close].to_string(),
        });
    }
    None
}

/// The value of attribute `name` in an opening tag, entities decoded.
fn html_attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!(" {name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = start + tag[start..].find('"')?;
    Some(decode_html_entities(&tag[start..end]))
}

/// Visible text of an HTML fragment: tags removed, entities decoded, runs of
/// whitespace collapsed.
fn html_text(fragment: &str) -> String {
    decode_html_entities(&strip_html_tags(fragment))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_html_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let decoded = rest.find(';').filter(|&semi| semi <= 10).and_then(|semi| {
            let body = &rest[1..semi];
            let ch = match body {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => body
                    .strip_prefix('#')
                    .and_then(|n| match n.strip_prefix(['x', 'X']) {
                        Some(hex) => u32::from_str_radix(hex, 16).ok(),
                        None => n.parse::<u32>().ok(),
                    })
                    .and_then(char::from_u32),
            }?;
            Some((ch, semi + 1))
        });
        match decoded {
            Some((ch, used)) => {
                out.push(ch);
                rest = &rest[used..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The page a DuckDuckGo result link leads to. A link is either the address
/// itself or a `duckduckgo.com/l/?uddg=<address>` redirect that carries it.
/// Only http(s) addresses are returned.
fn duckduckgo_destination(href: &str) -> Option<String> {
    let absolute = if let Some(rest) = href.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        href.to_string()
    };
    let parsed = reqwest::Url::parse(&absolute).ok()?;
    let target = if parsed.host_str().is_some_and(|h| h == "duckduckgo.com" || h.ends_with(".duckduckgo.com"))
        && parsed.path().starts_with("/l/")
    {
        let uddg = parsed.query_pairs().find(|(k, _)| k == "uddg")?.1.into_owned();
        reqwest::Url::parse(&uddg).ok()?
    } else {
        parsed
    };
    matches!(target.scheme(), "http" | "https").then(|| target.to_string())
}

/// Fetch a URL directly and return its bounded body, titled from its `<title>`.
/// Used by backends that have no content-extraction endpoint on the active
/// transport, so `web_fetch` still answers instead of erroring.
async fn fetch_url_direct(
    _client: &reqwest::Client,
    url: &str,
    provider: &str,
) -> Result<FetchedPage, String> {
    let resp = public_get(url, provider).await?;
    let status = resp.status();
    let body = read_body_capped(resp, MAX_RESPONSE_BYTES)
        .await
        .map_err(|e| format!("{provider} fetch: failed to read response body: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "{provider} fetch failed with HTTP {}",
            status.as_u16()
        ));
    }
    let title = extract_html_title(&body).unwrap_or_default();
    let (content, truncated) = bound_text(&body);
    Ok(FetchedPage {
        url: url.to_string(),
        title,
        content,
        truncated,
    })
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close = lower[open_end..].find("</title>")? + open_end;
    let title = html[open_end..close].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

fn bound_text(s: &str) -> (String, bool) {
    if s.chars().count() <= FETCH_MAX_CHARS {
        (s.to_string(), false)
    } else {
        (s.chars().take(FETCH_MAX_CHARS).collect(), true)
    }
}

pub fn clamp_count(requested: Option<u64>) -> u32 {
    match requested {
        Some(0) | None => SEARCH_DEFAULT_COUNT,
        Some(n) => (n as u32).min(SEARCH_MAX_COUNT),
    }
}

/// Read `resp`'s body as text, stopping after `cap` bytes. `.text()` buffers
/// the whole body first, however large; this never holds more than `cap`
/// bytes (plus one network chunk). Bytes are decoded as UTF-8, lossily, and a
/// character split by the cap is dropped.
async fn read_body_capped(mut resp: reqwest::Response, cap: usize) -> reqwest::Result<String> {
    let mut buf: Vec<u8> = Vec::new();
    if let Some(len) = resp.content_length() {
        buf.reserve(usize::try_from(len).unwrap_or(cap).min(cap));
    }
    while let Some(chunk) = resp.chunk().await? {
        let room = cap - buf.len();
        if chunk.len() >= room {
            buf.extend_from_slice(&chunk[..room]);
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    // Drop the connection instead of draining the rest of the body.
    drop(resp);
    let valid = match std::str::from_utf8(&buf) {
        Ok(_) => buf.len(),
        // Only a character cut short at the very end is dropped; bad bytes
        // elsewhere are replaced, as `.text()` would.
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(),
    };
    Ok(String::from_utf8_lossy(&buf[..valid]).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Jozkah/jan#182: an endless response body is cut off at the cap instead
    /// of being buffered until the request timeout (or memory) runs out.
    #[tokio::test]
    async fn an_endless_body_is_read_only_up_to_the_cap() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut req).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n")
                .await;
            let chunk = vec![b'a'; 16 * 1024];
            while sock.write_all(&chunk).await.is_ok() {}
        });
        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        let body = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            read_body_capped(resp, 64 * 1024),
        )
        .await
        .expect("reading an endless body must stop at the cap")
        .unwrap();
        assert_eq!(body.len(), 64 * 1024);
    }

    #[tokio::test]
    async fn a_split_utf8_character_at_the_cap_is_dropped() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut req).await;
            let body = "ab\u{e9}".as_bytes(); // the last character is two bytes
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(body).await;
        });
        let resp = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(read_body_capped(resp, 3).await.unwrap(), "ab");
    }

    /// Jozkah/jan#189: a model-driven `web_fetch` must not reach this machine
    /// or the local network. A listener on loopback stands in for a local
    /// service; the fetch is refused and the listener never sees a connection.
    #[tokio::test]
    async fn a_direct_fetch_never_reaches_a_local_address() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = build_http_client("test").unwrap();
        for url in [
            format!("http://127.0.0.1:{port}/"),
            format!("http://localhost:{port}/"),
            format!("http://[::ffff:127.0.0.1]:{port}/"),
        ] {
            assert!(http_get_page(&client, &url, "test").await.is_err(), "{url}");
            assert!(fetch_url_direct(&client, &url, "test").await.is_err(), "{url}");
        }
        let connected =
            tokio::time::timeout(std::time::Duration::from_millis(200), listener.accept()).await;
        assert!(connected.is_err(), "a local service received a connection");
    }

    #[test]
    fn only_public_addresses_are_fetchable() {
        for local in [
            "127.0.0.1", "127.8.9.10", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
            "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "240.0.0.1", "198.18.0.1",
            "::1", "::", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fc00::1", "fd12::1", "fe80::1",
            "64:ff9b::7f00:1", "ff02::1",
        ] {
            assert!(!is_public_ip(local.parse().unwrap()), "{local} counted as public");
        }
        for public in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public_ip(public.parse().unwrap()), "{public} counted as local");
        }
    }

    #[test]
    fn a_redirect_target_is_held_to_the_same_rule() {
        for refused in [
            "http://127.0.0.1/x",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data/",
            "http://LOCALHOST:8080/",
            "http://api.localhost/",
            "http://[::ffff:192.168.0.1]/",
        ] {
            assert!(check_public_url(&reqwest::Url::parse(refused).unwrap()).is_err(), "{refused}");
        }
        assert!(check_public_url(&reqwest::Url::parse("https://example.com/").unwrap()).is_ok());
    }

    #[test]
    fn clamp_count_defaults_and_caps() {
        assert_eq!(clamp_count(None), SEARCH_DEFAULT_COUNT);
        assert_eq!(clamp_count(Some(0)), SEARCH_DEFAULT_COUNT);
        assert_eq!(clamp_count(Some(3)), 3);
        assert_eq!(clamp_count(Some(1000)), SEARCH_MAX_COUNT);
    }

    #[test]
    fn empty_key_selects_hosted() {
        let p = ExaProvider::new(None).unwrap();
        assert_eq!(p.mode, ExaMode::Hosted);
        let p = ExaProvider::new(Some("  ".into())).unwrap();
        assert_eq!(p.mode, ExaMode::Hosted);
        let p = ExaProvider::new(Some("YOUR_EXA_API_KEY_HERE".into())).unwrap();
        assert_eq!(p.mode, ExaMode::Hosted);
    }

    #[test]
    fn real_key_selects_rest() {
        let p = ExaProvider::new(Some("abc123".into())).unwrap();
        assert_eq!(p.mode, ExaMode::Rest("abc123".into()));
    }

    #[test]
    fn create_provider_defaults_to_exa() {
        assert!(create_provider(None, None, None).is_ok());
        assert!(create_provider(Some(""), None, None).is_ok());
        assert!(create_provider(Some("Exa"), None, None).is_ok());
    }

    #[test]
    fn create_provider_rejects_unknown() {
        match create_provider(Some("nonesuch"), None, None) {
            Ok(_) => panic!("expected unknown provider to error"),
            Err(e) => assert!(e.contains("nonesuch")),
        }
    }

    #[test]
    fn create_provider_tavily_requires_key() {
        match create_provider(Some("tavily"), None, None) {
            Ok(_) => panic!("expected Tavily to require a key"),
            Err(e) => assert!(e.contains("Tavily")),
        }
        assert!(create_provider(Some("tavily"), Some("tvly-abc".into()), None).is_ok());
    }

    #[test]
    fn create_provider_brave_requires_key() {
        match create_provider(Some("brave"), None, None) {
            Ok(_) => panic!("expected Brave to require a key"),
            Err(e) => assert!(e.contains("Brave")),
        }
        assert!(create_provider(Some("brave"), Some("brv-abc".into()), None).is_ok());
    }

    #[test]
    fn create_provider_serper_requires_key_and_google_alias() {
        match create_provider(Some("serper"), None, None) {
            Ok(_) => panic!("expected Serper to require a key"),
            Err(e) => assert!(e.contains("Serper")),
        }
        assert!(create_provider(Some("serper"), Some("srp-abc".into()), None).is_ok());
        // "google" is an alias for the Serper-backed adapter.
        assert!(create_provider(Some("google"), Some("srp-abc".into()), None).is_ok());
    }

    /// A missing key is reported with the actionable guidance, not just "an
    /// error": it names where to set the key and the keyless providers, so the
    /// caller has a way forward rather than a dead end -- the exact gap the
    /// screenshot's bare "Serper requires an API key" left.
    #[test]
    fn a_missing_key_error_is_actionable() {
        let err = match create_provider(Some("serper"), None, None) {
            Ok(_) => panic!("expected Serper to require a key"),
            Err(e) => e,
        };
        // Still names the provider and the core reason (kept so existing
        // matchers on "requires an API key" continue to hold).
        assert!(err.contains("Serper"), "{err}");
        assert!(err.contains("requires an API key"), "{err}");
        // New: says the key is not configured, where to add it, and that Exa /
        // You.com work with no key.
        assert!(err.contains("none is configured"), "{err}");
        assert!(err.contains("Settings > Web Search"), "{err}");
        assert!(err.contains("Exa") && err.contains("You.com"), "{err}");
        assert!(err.contains("no API key"), "{err}");
        // Every keyed provider gets the same actionable shape.
        for provider in ["tavily", "brave"] {
            match create_provider(Some(provider), None, None) {
                Ok(_) => panic!("expected {provider} to require a key"),
                Err(e) => {
                    assert!(e.contains("Settings > Web Search"), "{provider}: {e}");
                    assert!(e.contains("no API key"), "{provider}: {e}");
                }
            }
        }
    }

    #[test]
    fn normalize_brave_search_maps_contract() {
        let body = json!({
            "web": {
                "results": [
                    {
                        "title": "Example",
                        "url": "https://example.com",
                        "description": "A <strong>short</strong> excerpt.",
                        "page_age": "2024-05-01T00:00:00"
                    },
                    { "title": "No date", "url": "https://example.org", "description": "Body." }
                ]
            }
        });
        let results = normalize_brave_search(&body, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "A short excerpt.");
        assert_eq!(results[0].published_at.as_deref(), Some("2024-05-01T00:00:00"));
        assert!(results[1].published_at.is_none());
    }

    #[test]
    fn normalize_brave_search_caps_and_empty() {
        let body = json!({
            "web": { "results": [
                { "title": "1", "url": "https://a", "description": "" },
                { "title": "2", "url": "https://b", "description": "" }
            ]}
        });
        assert_eq!(normalize_brave_search(&body, 1).len(), 1);
        assert!(normalize_brave_search(&json!({}), 5).is_empty());
        assert!(normalize_brave_search(&json!({"web": {}}), 5).is_empty());
    }

    #[test]
    fn normalize_serper_search_maps_contract() {
        let body = json!({
            "organic": [
                {
                    "title": "Example",
                    "link": "https://example.com",
                    "snippet": "A short excerpt.",
                    "date": "May 1, 2024"
                },
                { "title": "No date", "link": "https://example.org", "snippet": "Body." }
            ]
        });
        let results = normalize_serper_search(&body, 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "A short excerpt.");
        assert_eq!(results[0].published_at.as_deref(), Some("May 1, 2024"));
        assert!(results[1].published_at.is_none());
    }

    #[test]
    fn normalize_serper_search_caps_and_empty() {
        let body = json!({
            "organic": [
                { "title": "1", "link": "https://a", "snippet": "x" },
                { "title": "2", "link": "https://b", "snippet": "y" }
            ]
        });
        assert_eq!(normalize_serper_search(&body, 1).len(), 1);
        assert!(normalize_serper_search(&json!({}), 5).is_empty());
    }

    #[test]
    fn strip_html_tags_removes_markup() {
        assert_eq!(strip_html_tags("a <strong>b</strong> c"), "a b c");
        assert_eq!(strip_html_tags("plain"), "plain");
    }

    #[test]
    fn create_provider_searxng_requires_valid_url() {
        match create_provider(Some("searxng"), None, None) {
            Ok(_) => panic!("expected SearXNG to require an instance URL"),
            Err(e) => assert!(e.contains("SearXNG")),
        }
        match create_provider(Some("searxng"), None, Some("example.com".into())) {
            Ok(_) => panic!("expected SearXNG to reject a scheme-less URL"),
            Err(e) => assert!(e.contains("http")),
        }
        assert!(
            create_provider(Some("searxng"), None, Some("https://searx.example/".into())).is_ok()
        );
    }

    /// A results page shaped like the live one: a plain link, a `uddg` redirect
    /// link, an ad, a repeat of the first result, and entities in the text.
    const DDG_PAGE: &str = r#"<div id="links" class="results">
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://docs.rs/async-trait/latest/async_trait/">async_trait - Rust - Docs.rs</a></h2>
        <a class="result__snippet" href="https://docs.rs/async-trait/">It is the intention that all features of <b>Rust</b> <b>traits</b> work &amp; more.</a>
      </div>
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1%26c%3D2&amp;rut=abc">Tom &amp; Jerry&#x27;s  guide</a></h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa">Second   snippet</a>
      </div>
      <div class="result results_links results_links_deep result--ad">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://ads.example.com/">Buy things</a></h2>
        <a class="result__snippet" href="https://ads.example.com/">An ad</a>
      </div>
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://docs.rs/async-trait/latest/async_trait/">A repeat</a></h2>
      </div>
      <div class="result results_links results_links_deep web-result ">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="javascript:alert(1)">Not a web page</a></h2>
      </div>
    </div>"#;

    #[test]
    fn duckduckgo_results_are_read_in_order_with_real_urls() {
        let results = parse_duckduckgo_results(DDG_PAGE, 10);
        assert_eq!(results.len(), 2, "the ad, the repeat and the non-http link are dropped: {results:?}");
        assert_eq!(results[0].url, "https://docs.rs/async-trait/latest/async_trait/");
        assert_eq!(results[0].title, "async_trait - Rust - Docs.rs");
        assert_eq!(
            results[0].snippet,
            "It is the intention that all features of Rust traits work & more."
        );
        // The redirect wrapper is unwrapped, its query string intact.
        assert_eq!(results[1].url, "https://example.org/a?b=1&c=2");
        assert_eq!(results[1].title, "Tom & Jerry's guide");
        assert_eq!(results[1].snippet, "Second snippet");
        assert!(results.iter().all(|r| r.published_at.is_none()));
    }

    #[test]
    fn duckduckgo_results_respect_the_count() {
        assert_eq!(parse_duckduckgo_results(DDG_PAGE, 1).len(), 1);
        assert!(parse_duckduckgo_results(DDG_PAGE, 0).is_empty());
    }

    #[test]
    fn a_duckduckgo_page_with_no_results_is_an_empty_list_not_an_error() {
        assert!(parse_duckduckgo_results("<html><body><div class=\"no-results\">No results.</div></body></html>", 5).is_empty());
        assert!(parse_duckduckgo_results("", 5).is_empty());
    }

    #[test]
    fn a_duckduckgo_bot_check_is_recognised() {
        assert!(is_duckduckgo_bot_check("<div class=\"anomaly-modal__modal\">Unfortunately, bots use DuckDuckGo too.</div>"));
        assert!(is_duckduckgo_bot_check("<form id=\"challenge-form\" action=\"//duckduckgo.com/anomaly.js\">"));
        assert!(!is_duckduckgo_bot_check(DDG_PAGE));
        assert!(DUCKDUCKGO_BOT_CHECK.contains("Exa or You.com"));
    }

    #[test]
    fn duckduckgo_destinations_are_only_web_addresses() {
        assert_eq!(duckduckgo_destination("https://a.example/x").as_deref(), Some("https://a.example/x"));
        assert_eq!(
            duckduckgo_destination("//duckduckgo.com/l/?uddg=http%3A%2F%2Fb.example%2F").as_deref(),
            Some("http://b.example/")
        );
        assert_eq!(
            duckduckgo_destination("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fc.example%2Fp&rut=1").as_deref(),
            Some("https://c.example/p")
        );
        for bad in ["", "javascript:alert(1)", "/relative/path", "https://duckduckgo.com/l/?rut=1", "https://duckduckgo.com/l/?uddg=ftp%3A%2F%2Fx"] {
            assert_eq!(duckduckgo_destination(bad), None, "{bad}");
        }
    }

    #[test]
    fn html_entities_decode_named_and_numeric_forms_and_leave_the_rest() {
        assert_eq!(decode_html_entities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2019;f&nbsp;g"), "a & b <c> \"d\" 'e' \u{2019}f g");
        assert_eq!(decode_html_entities("AT&T &unknown; & lone &#xZZ; end&"), "AT&T &unknown; & lone &#xZZ; end&");
    }

    #[test]
    fn duckduckgo_needs_no_key_or_endpoint_and_has_an_alias() {
        assert!(create_provider(Some("duckduckgo"), None, None).is_ok());
        assert!(create_provider(Some("DDG"), None, None).is_ok());
        assert!(create_provider(Some("duckduckgo"), Some("ignored".into()), Some("also-ignored".into())).is_ok());
    }

    /// A page fetched through this provider goes through the same public-only
    /// client as every other backend: it cannot reach this machine.
    #[tokio::test]
    async fn a_duckduckgo_fetch_never_reaches_a_local_address() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let provider = DuckDuckGoProvider::new().unwrap();
        assert!(provider.fetch(&format!("http://127.0.0.1:{port}/")).await.is_err());
        let connected = tokio::time::timeout(std::time::Duration::from_millis(300), listener.accept()).await;
        assert!(connected.is_err(), "nothing may connect to the local listener");
    }

    /// Talks to the real site, so it is skipped by default:
    /// `cargo test -p tauri-plugin-websearch -- --ignored duckduckgo_live`.
    #[tokio::test]
    #[ignore = "needs network access to duckduckgo.com"]
    async fn duckduckgo_live_search_returns_real_results() {
        let provider = DuckDuckGoProvider::new().unwrap();
        let results = provider.search("rust programming language", 5).await.unwrap();
        assert!(!results.is_empty(), "expected results");
        for r in &results {
            assert!(r.url.starts_with("http"), "{r:?}");
            assert!(!r.title.is_empty(), "{r:?}");
            assert!(!r.url.contains("duckduckgo.com/l/"), "redirect not unwrapped: {r:?}");
        }
    }

    #[test]
    fn normalize_searxng_search_maps_and_caps() {
        let body = json!({
            "results": [
                { "title": "One", "url": "https://a.example", "content": "first", "publishedDate": "2024-01-01" },
                { "title": "Two", "url": "https://b.example", "content": "second" },
                { "title": "Three", "url": "https://c.example", "content": "third" }
            ]
        });
        let results = normalize_searxng_search(&body, 2);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://a.example");
        assert_eq!(results[0].published_at.as_deref(), Some("2024-01-01"));
        assert!(results[1].published_at.is_none());
    }

    #[test]
    fn extract_html_title_reads_title_tag() {
        assert_eq!(
            extract_html_title("<html><head><TITLE>Hello</TITLE></head>").as_deref(),
            Some("Hello")
        );
        assert!(extract_html_title("<html>no title</html>").is_none());
    }

    #[test]
    fn normalize_tavily_search_maps_contract() {
        let body = json!({
            "results": [
                {
                    "title": "Example",
                    "url": "https://example.com",
                    "content": "A short excerpt.",
                    "published_date": "2024-05-01"
                },
                { "title": "No date", "url": "https://example.org", "content": "Body." }
            ]
        });
        let results = normalize_tavily_search(&body);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "A short excerpt.");
        assert_eq!(results[0].published_at.as_deref(), Some("2024-05-01"));
        assert!(results[1].published_at.is_none());
    }

    #[test]
    fn normalize_tavily_search_empty_is_empty() {
        assert!(normalize_tavily_search(&json!({})).is_empty());
        assert!(normalize_tavily_search(&json!({"results": []})).is_empty());
    }

    #[test]
    fn normalize_tavily_extract_reads_raw_content() {
        let body = json!({
            "results": [
                { "url": "https://example.com", "raw_content": "hello world" }
            ]
        });
        let page = normalize_tavily_extract(&body, "https://example.com").unwrap();
        assert!(page.title.is_empty());
        assert_eq!(page.content, "hello world");
        assert!(!page.truncated);
    }

    #[test]
    fn normalize_tavily_extract_no_results_errors() {
        assert!(normalize_tavily_extract(&json!({"results": []}), "u").is_err());
    }

    #[test]
    fn parse_hosted_result_text_reads_sse_frame() {
        let sse = "event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n\n";
        assert_eq!(parse_hosted_result_text(sse, "Exa").unwrap(), "hello");
    }

    #[test]
    fn parse_hosted_result_text_reads_raw_json() {
        let raw = "{\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}";
        assert_eq!(parse_hosted_result_text(raw, "Exa").unwrap(), "hi");
    }

    #[test]
    fn parse_hosted_result_text_surfaces_errors() {
        let err = "{\"error\":{\"code\":-32000,\"message\":\"boom\"}}";
        assert!(parse_hosted_result_text(err, "Exa").is_err());
        let tool_err = "{\"result\":{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"bad\"}]}}";
        assert!(parse_hosted_result_text(tool_err, "Exa")
            .unwrap_err()
            .contains("bad"));
    }

    #[test]
    fn parse_hosted_result_text_surfaces_rate_limit_as_error() {
        // Verbatim shape of a throttled `mcp.exa.ai/mcp` reply: the call
        // "succeeds" (no `isError`, HTTP 200) and the refusal is prose in the
        // text block, so only `_meta` distinguishes it from a real answer.
        let sse = format!(
            "event: message\ndata: {}\n\n",
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "_meta": { "ai.exa/rateLimited": true },
                    "content": [{
                        "type": "text",
                        "text": "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key."
                    }]
                }
            })
        );
        let err = parse_hosted_result_text(&sse, "Exa")
            .expect_err("a throttled reply must not read as a successful search");
        assert!(err.contains("rate limit"), "unexpected message: {err}");
    }

    #[test]
    fn parse_hosted_result_text_ignores_unrelated_meta() {
        let raw = json!({
            "result": {
                "_meta": { "ai.exa/cached": true },
                "content": [{ "type": "text", "text": "hello" }]
            }
        })
        .to_string();
        assert_eq!(parse_hosted_result_text(&raw, "Exa").unwrap(), "hello");
    }

    #[test]
    fn parse_hosted_result_text_rate_limit_flag_must_be_true() {
        let raw = json!({
            "result": {
                "_meta": { "ai.exa/rateLimited": false },
                "content": [{ "type": "text", "text": "hello" }]
            }
        })
        .to_string();
        assert_eq!(parse_hosted_result_text(&raw, "Exa").unwrap(), "hello");
    }

    #[test]
    fn parse_hosted_search_text_maps_contract() {
        let text = "Title: Paris | Britannica\nURL: https://www.britannica.com/place/Paris\nPublished: 1998-07-20T00:00:00.000Z\nAuthor: N/A\nHighlights:\nParis is the capital of France.\n...\nSecond highlight.\n---\nTitle: Paris\nURL: https://en.wikipedia.org/wiki/Paris\nPublished: N/A\nAuthor: N/A\nHighlights:\nParis is the capital and largest city of France.";
        let results = parse_hosted_search_text(text);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Paris | Britannica");
        assert_eq!(results[0].url, "https://www.britannica.com/place/Paris");
        assert_eq!(
            results[0].published_at.as_deref(),
            Some("1998-07-20T00:00:00.000Z")
        );
        assert!(results[0].snippet.contains("capital of France"));
        assert!(!results[0].snippet.contains("..."));
        assert!(results[1].published_at.is_none());
        assert_eq!(results[1].url, "https://en.wikipedia.org/wiki/Paris");
    }

    #[test]
    fn parse_hosted_search_text_empty_is_empty() {
        assert!(parse_hosted_search_text("").is_empty());
        assert!(parse_hosted_search_text("   \n  ").is_empty());
    }

    #[test]
    fn parse_hosted_fetch_text_extracts_title_url_body() {
        let text = "# Paris\nURL: https://en.wikipedia.org/wiki/Paris\n\nParis is the capital and largest city of France.";
        let page = parse_hosted_fetch_text(text, "https://en.wikipedia.org/wiki/Paris");
        assert_eq!(page.title, "Paris");
        assert_eq!(page.url, "https://en.wikipedia.org/wiki/Paris");
        assert!(page.content.starts_with("Paris is the capital"));
        assert!(!page.truncated);
    }

    #[test]
    fn parse_hosted_fetch_text_truncates_large_body() {
        let big = "a".repeat(FETCH_MAX_CHARS + 100);
        let text = format!("# T\nURL: https://x\n\n{big}");
        let page = parse_hosted_fetch_text(&text, "https://x");
        assert!(page.truncated);
        assert_eq!(page.content.chars().count(), FETCH_MAX_CHARS);
    }

    #[test]
    fn normalize_exa_rest_search_maps_contract() {
        let body = json!({
            "results": [
                {
                    "title": "Example",
                    "url": "https://example.com",
                    "highlights": ["Short result excerpt"],
                    "publishedDate": "2024-01-02T00:00:00.000Z"
                },
                {
                    "title": "No highlight",
                    "url": "https://example.org",
                    "text": "Body text fallback used as snippet."
                }
            ]
        });
        let results = normalize_exa_rest_search(&body);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].snippet, "Short result excerpt");
        assert_eq!(
            results[0].published_at.as_deref(),
            Some("2024-01-02T00:00:00.000Z")
        );
        assert!(results[1].snippet.starts_with("Body text fallback"));
        assert!(results[1].published_at.is_none());
    }

    #[test]
    fn normalize_exa_rest_search_empty_is_empty() {
        assert!(normalize_exa_rest_search(&json!({})).is_empty());
        assert!(normalize_exa_rest_search(&json!({"results": []})).is_empty());
    }

    #[test]
    fn normalize_exa_rest_fetch_bounds_and_titles() {
        let body = json!({
            "results": [ { "url": "https://example.com", "title": "T", "text": "hello world" } ]
        });
        let page = normalize_exa_rest_fetch(&body, "https://example.com").unwrap();
        assert_eq!(page.title, "T");
        assert_eq!(page.content, "hello world");
        assert!(!page.truncated);
    }

    #[test]
    fn normalize_exa_rest_fetch_no_results_errors() {
        assert!(normalize_exa_rest_fetch(&json!({"results": []}), "u").is_err());
    }

    #[test]
    fn youcom_attribution_follows_the_client_info_grammar() {
        // `<source>; client=<name>/<version>; ua=<runtime>/<version>`
        let segments: Vec<&str> = YOU_COM_CLIENT_INFO.split("; ").collect();
        assert_eq!(segments.len(), 3, "unexpected segment count");
        assert_eq!(segments[0], "plugin");
        let client = segments[1]
            .strip_prefix("client=")
            .expect("second segment names the client");
        let (name, version) = client.split_once('/').expect("client carries a version");
        assert_eq!(name, "jan-websearch");
        assert!(!version.is_empty(), "client version must not be empty");
        assert!(segments[2].starts_with("ua="));
        // Values are interpolated verbatim; a stray delimiter would corrupt
        // the segment split on the receiving side.
        assert!(segments.iter().all(|s| !s.contains(';')));
        assert!(YOU_COM_USER_AGENT.starts_with("jan-websearch/"));
        assert!(YOU_COM_USER_AGENT.contains("github.com/Jozkah/flint"));
    }

    #[test]
    fn youcom_requests_send_a_single_content_type() {
        // Regression test: reqwest's `.json()` sets `Content-Type` and
        // `.header()` appends, so an extra explicit header produced a
        // duplicated `content-type: application/json` — which api.you.com
        // rejects with HTTP 415 ("Content-Type must be application/json").
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call" });
        let req = with_youcom_headers(
            YouComProvider::new(None)
                .unwrap()
                .client
                .post(YOU_COM_HOSTED_URL)
                .header("accept", "application/json, text/event-stream")
                .json(&body),
        )
        .build()
        .unwrap();
        assert_eq!(req.headers().get_all("content-type").iter().count(), 1);
        assert_eq!(
            req.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert!(req.headers().contains_key("user-agent"));
        assert!(req.headers().contains_key("x-client-info"));
    }

    #[test]
    fn youcom_key_selects_transport() {
        assert_eq!(YouComProvider::new(None).unwrap().mode, YouComMode::Hosted);
        assert_eq!(
            YouComProvider::new(Some("   ".into())).unwrap().mode,
            YouComMode::Hosted
        );
        assert_eq!(
            YouComProvider::new(Some("ydc-key".into())).unwrap().mode,
            YouComMode::Rest("ydc-key".into())
        );
    }

    #[test]
    fn create_provider_youcom_works_with_and_without_key() {
        assert!(create_provider(Some("you"), None, None).is_ok());
        assert!(create_provider(Some("you"), Some("ydc-key".into()), None).is_ok());
    }

    #[test]
    fn parse_hosted_result_text_youcom_skips_notification_frames() {
        // The hosted endpoint emits a progress notification ahead of the
        // answer, so the result is not the first `data:` frame.
        let payload = json!({
            "results": {
                "web": [
                    { "url": "https://example.com", "title": "T", "description": "D" }
                ]
            }
        });
        let sse = format!(
            "event: message\ndata: {}\n\nevent: message\ndata: {}\n\n",
            json!({
                "jsonrpc": "2.0",
                "method": "notifications/message",
                "params": { "level": "info", "data": "searching" }
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": { "content": [{ "type": "text", "text": payload.to_string() }] }
            })
        );
        let text = parse_hosted_result_text(&sse, "You.com").expect("result frame must be found");
        // The hosted payload is the same shape the REST endpoint returns, so
        // the REST normalizer reads it unchanged.
        let parsed: Value = serde_json::from_str(&text).expect("tool payload is JSON");
        let results = normalize_youcom_search(&parsed);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "D");
    }

    #[test]
    fn parse_hosted_result_text_youcom_reads_bare_json_body() {
        let raw = json!({"result": {"content": [{"type": "text", "text": "hi"}]}}).to_string();
        assert_eq!(parse_hosted_result_text(&raw, "You.com").unwrap(), "hi");
    }

    #[test]
    fn parse_hosted_result_text_youcom_surfaces_errors() {
        let err = json!({"error": {"code": -32000, "message": "boom"}}).to_string();
        assert!(parse_hosted_result_text(&err, "You.com")
            .unwrap_err()
            .contains("boom"));

        let tool_err = json!({
            "result": {
                "isError": true,
                "content": [{"type": "text", "text": "quota exceeded"}]
            }
        })
        .to_string();
        assert!(parse_hosted_result_text(&tool_err, "You.com")
            .unwrap_err()
            .contains("quota exceeded"));

        // A stream that never carries an answer must error rather than
        // silently returning the notification.
        let only_notification = format!(
            "event: message\ndata: {}\n\n",
            json!({"jsonrpc": "2.0", "method": "notifications/message", "params": {}})
        );
        assert!(parse_hosted_result_text(&only_notification, "You.com").is_err());
    }

    #[test]
    fn normalize_youcom_search_maps_contract() {
        // Field set mirrors a live `ydc-index.io/v1/search` web result,
        // including the thumbnail and favicon keys the normalizer ignores.
        let body = json!({
            "results": {
                "web": [
                    {
                        "url": "https://example.com",
                        "title": "Example",
                        "description": "A short summary.",
                        "snippets": ["first excerpt", "second excerpt"],
                        "thumbnail_url": "https://cdn.example.com/img.jpg",
                        "original_thumbnail_url": "https://cdn.example.com/img.jpg",
                        "favicon_url": "https://example.com/favicon.ico",
                        "page_age": "2024-05-01T00:00:00.000Z"
                    },
                    { "url": "https://example.org", "title": "No date", "description": "Body." }
                ]
            }
        });
        let results = normalize_youcom_search(&body);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://example.com");
        // Description wins over snippets when both are present.
        assert_eq!(results[0].snippet, "A short summary.");
        assert_eq!(
            results[0].published_at.as_deref(),
            Some("2024-05-01T00:00:00.000Z")
        );
        assert!(results[1].published_at.is_none());
    }

    #[test]
    fn normalize_youcom_search_falls_back_to_snippet_when_no_description() {
        let body = json!({
            "results": {
                "web": [
                    {
                        "url": "https://example.com",
                        "title": "Missing",
                        "snippets": ["passage one", "passage two"]
                    },
                    {
                        "url": "https://example.org",
                        "title": "Empty",
                        "description": "",
                        "snippets": ["passage three"]
                    }
                ]
            }
        });
        let results = normalize_youcom_search(&body);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].snippet, "passage one");
        // An empty description falls through to snippets rather than
        // yielding an empty snippet.
        assert_eq!(results[1].snippet, "passage three");
    }

    #[test]
    fn normalize_youcom_search_clips_long_snippet() {
        let body = json!({
            "results": {
                "web": [
                    { "url": "https://example.com", "description": "x".repeat(900) }
                ]
            }
        });
        let results = normalize_youcom_search(&body);
        assert_eq!(results[0].snippet.chars().count(), 500);
    }

    #[test]
    fn normalize_youcom_search_empty_or_news_only_is_empty() {
        // A news-only response must not be reported as web results.
        let news_only = json!({
            "results": { "news": [{ "url": "https://x", "title": "X" }] }
        });
        assert!(normalize_youcom_search(&news_only).is_empty());
        assert!(normalize_youcom_search(&json!({})).is_empty());
        assert!(normalize_youcom_search(&json!({"results": {}})).is_empty());
        assert!(normalize_youcom_search(&json!({"results": {"web": []}})).is_empty());
    }

    #[test]
    fn normalize_youcom_contents_reads_markdown() {
        let body = json!([
            { "url": "https://example.com", "title": "T", "markdown": "hello world" }
        ]);
        let page = normalize_youcom_contents(&body, "https://example.com").unwrap();
        assert_eq!(page.title, "T");
        assert_eq!(page.url, "https://example.com");
        assert_eq!(page.content, "hello world");
        assert!(!page.truncated);
    }

    #[test]
    fn normalize_youcom_contents_truncates_and_marks_truncated() {
        let big = "a".repeat(FETCH_MAX_CHARS + 100);
        let body = json!([
            { "url": "https://example.com", "title": "T", "markdown": big }
        ]);
        let page = normalize_youcom_contents(&body, "https://example.com").unwrap();
        assert!(page.truncated);
        assert_eq!(page.content.chars().count(), FETCH_MAX_CHARS);
    }

    #[test]
    fn normalize_youcom_contents_no_results_errors() {
        assert!(normalize_youcom_contents(&json!([]), "u").is_err());
        // A non-array body must error rather than panic.
        assert!(normalize_youcom_contents(&json!({"results": []}), "u").is_err());
        // The spec types `markdown` as nullable for failed extractions; a null,
        // missing, or empty `markdown` must error rather than return an empty page.
        let null_markdown = json!([{ "url": "https://example.com", "markdown": null }]);
        assert!(normalize_youcom_contents(&null_markdown, "u").is_err());
        let no_markdown = json!([{ "url": "https://example.com", "title": "T" }]);
        assert!(normalize_youcom_contents(&no_markdown, "u").is_err());
        let empty_markdown = json!([{ "url": "https://example.com", "markdown": "" }]);
        assert!(normalize_youcom_contents(&empty_markdown, "u").is_err());
    }
}
