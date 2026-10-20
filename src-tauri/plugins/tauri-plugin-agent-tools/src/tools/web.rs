//! Native, provider-neutral web tools compiled into the agent core.
//!
//! This module implements `web_search` and `web_fetch` as first-class built-in
//! tools - NOT as an MCP server registered with the agent. The agent calls the
//! stable, provider-neutral tool names (`web_search` / `web_fetch`) and never a
//! provider-branded name such as `exa_search`.
//!
//! The search backend, credential handling, and response normalization live in
//! `tauri_plugin_websearch::provider` and are shared with the desktop
//! `web_search`/`web_fetch` Tauri commands so there is a single implementation.
//! This module owns only the agent tool contract: argument parsing/validation,
//! selecting the keyless-vs-keyed Exa path from the process environment, and
//! rendering normalized results as compact, model-friendly text.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri_plugin_websearch::provider::{clamp_count, create_provider, FetchedPage, SearchResult};

/// Characters of a page `web_fetch` returns per call; the model reads the rest
/// with `offset`.
const FETCH_PAGE_CHARS: usize = 40_000;
/// How long a fetched page is reused so paging does not refetch.
const FETCH_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
/// Pages kept at once (each up to the provider bound, 100k characters).
const FETCH_CACHE_MAX_ENTRIES: usize = 16;

/// Short-lived in-memory page cache keyed by URL.
#[derive(Default)]
struct FetchCache {
    pages: HashMap<String, (Instant, FetchedPage)>,
}

impl FetchCache {
    fn get(&mut self, url: &str, now: Instant) -> Option<FetchedPage> {
        match self.pages.get(url) {
            Some((at, page)) if now.duration_since(*at) < FETCH_CACHE_TTL => Some(page.clone()),
            Some(_) => {
                self.pages.remove(url);
                None
            }
            None => None,
        }
    }

    fn put(&mut self, url: &str, page: FetchedPage, now: Instant) {
        self.pages
            .retain(|_, (at, _)| now.duration_since(*at) < FETCH_CACHE_TTL);
        if self.pages.len() >= FETCH_CACHE_MAX_ENTRIES && !self.pages.contains_key(url) {
            if let Some(oldest) = self
                .pages
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                self.pages.remove(&oldest);
            }
        }
        self.pages.insert(url.to_string(), (now, page));
    }
}

fn fetch_cache() -> &'static Mutex<FetchCache> {
    static CACHE: std::sync::OnceLock<Mutex<FetchCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// Environment variables consulted for an optional Exa credential, in priority
/// order. `JAN_EXA_API_KEY` is Jan's namespaced variable; `EXA_API_KEY` matches
/// Exa's own convention and the key already used by the legacy Exa MCP
/// registration, so an existing configuration keeps working. When neither is
/// set, the keyless hosted path is used automatically.
const EXA_API_KEY_ENVS: &[&str] = &["JAN_EXA_API_KEY", "EXA_API_KEY"];

fn exa_api_key() -> Option<String> {
    for var in EXA_API_KEY_ENVS {
        if let Ok(v) = std::env::var(var) {
            let v = v.trim();
            if !v.is_empty() && v != "YOUR_EXA_API_KEY_HERE" {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Execute the `web_search` built-in. Returns the tool-result text; errors are
/// returned as a `String` starting with "ERROR" to match the other handlers.
pub async fn web_search(args: &Value) -> String {
    let Some(query) = args.get("query").and_then(|v| v.as_str()).map(str::trim) else {
        return "ERROR: web_search requires a 'query' string argument.".to_string();
    };
    if query.is_empty() {
        return "ERROR: web_search 'query' must not be empty.".to_string();
    }
    let count = clamp_count(args.get("count").and_then(|v| v.as_u64()));
    let provider = match create_provider(None, exa_api_key(), None) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match provider.search(query, count).await {
        Ok(results) if results.is_empty() => {
            format!("No web search results found for query: {query}")
        }
        Ok(results) => render_search_results(&results),
        Err(e) => format!("ERROR: {e}"),
    }
}

/// Execute the `web_fetch` built-in. Returns bounded readable content with its
/// source URL/title; errors start with "ERROR".
pub async fn web_fetch(args: &Value, read_roots: &[std::path::PathBuf]) -> String {
    let Some(url) = args.get("url").and_then(|v| v.as_str()).map(str::trim) else {
        return "ERROR: web_fetch requires a 'url' string argument.".to_string();
    };
    if url.is_empty() {
        return "ERROR: web_fetch 'url' must not be empty.".to_string();
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return format!("ERROR: web_fetch 'url' must be an http(s) URL, got: {url}");
    }
    let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let cached = fetch_cache()
        .lock()
        .ok()
        .and_then(|mut c| c.get(url, Instant::now()));
    if let Some(page) = cached {
        return render_fetched_page(&page, offset);
    }
    let provider = match create_provider(None, exa_api_key(), None) {
        Ok(p) => p,
        Err(e) => return e,
    };
    match provider.fetch(url).await {
        Ok(page) => {
            if let Ok(mut c) = fetch_cache().lock() {
                c.put(url, page.clone(), Instant::now());
            }
            render_fetched_page(&page, offset)
        }
        Err(e) => {
            // A private GitHub repo returns a not-found/auth failure to the
            // anonymous crawler. Rather than leave the model to retry or switch
            // provider, hand it the native-Git recovery: a matching attached
            // clone to inspect, or the choices to offer the user.
            let mut msg = format!("ERROR: {e}");
            if let Some(note) =
                crate::tools::git_native::web_fetch_recovery_note(url, &e, read_roots)
            {
                msg.push_str(&note);
            }
            msg
        }
    }
}

/// Render normalized results as compact, model-friendly text with citations.
fn render_search_results(results: &[SearchResult]) -> String {
    let mut out = String::new();
    for (i, r) in results.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", i + 1, r.title));
        out.push_str(&format!("   URL: {}\n", r.url));
        if let Some(date) = &r.published_at {
            out.push_str(&format!("   Published: {date}\n"));
        }
        if !r.snippet.is_empty() {
            out.push_str(&format!("   {}\n", r.snippet.replace('\n', " ")));
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Render one window of a fetched page (`FETCH_PAGE_CHARS` from `offset`, in
/// characters) headed by its source URL/title, with a note saying how much is
/// left and which offset reads it.
fn render_fetched_page(page: &FetchedPage, offset: usize) -> String {
    let total = page.content.chars().count();
    let mut out = String::new();
    if !page.title.is_empty() {
        out.push_str(&format!("Title: {}\n", page.title));
    }
    out.push_str(&format!("URL: {}\n\n", page.url));
    if offset >= total && total > 0 {
        out.push_str(&format!(
            "[offset {offset} is past the end: the page has {total} characters]"
        ));
        return out;
    }
    let window: String = page
        .content
        .chars()
        .skip(offset)
        .take(FETCH_PAGE_CHARS)
        .collect();
    let end = offset + window.chars().count();
    out.push_str(&window);
    if end < total {
        out.push_str(&format!(
            "\n\n[showing characters {offset}-{end} of {total}; {} characters unread. Call web_fetch again with offset={end} to read the next part.]",
            total - end
        ));
    } else if page.truncated {
        out.push_str(&format!(
            "\n\n[end of the readable part: the page was longer, only its first {total} characters are available]"
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn web_search_requires_query() {
        assert!(web_search(&json!({})).await.starts_with("ERROR"));
        assert!(web_search(&json!({"query": "   "}))
            .await
            .starts_with("ERROR"));
    }

    #[tokio::test]
    async fn web_fetch_validates_url() {
        assert!(web_fetch(&json!({}), &[]).await.starts_with("ERROR"));
        assert!(web_fetch(&json!({"url": "ftp://x"}), &[])
            .await
            .starts_with("ERROR"));
    }

    #[test]
    fn render_search_results_cites_urls() {
        let results = vec![SearchResult {
            title: "T".into(),
            url: "https://example.com".into(),
            snippet: "snip".into(),
            published_at: None,
        }];
        let rendered = render_search_results(&results);
        assert!(rendered.contains("https://example.com"));
        assert!(rendered.contains("snip"));
    }

    #[test]
    fn render_fetched_page_includes_source() {
        let page = FetchedPage {
            url: "https://example.com".into(),
            title: "Title".into(),
            content: "body".into(),
            truncated: true,
        };
        let rendered = render_fetched_page(&page, 0);
        assert!(rendered.contains("URL: https://example.com"));
        assert!(rendered.contains("Title: Title"));
        assert!(rendered.contains("first 4 characters"));
    }

    fn page_of(n: usize) -> FetchedPage {
        FetchedPage {
            url: "https://example.com".into(),
            title: String::new(),
            content: "a".repeat(n),
            truncated: false,
        }
    }

    #[test]
    fn long_page_reports_unread_and_next_offset() {
        let rendered = render_fetched_page(&page_of(FETCH_PAGE_CHARS + 500), 0);
        assert!(rendered.contains("500 characters unread"), "{rendered}");
        assert!(rendered.contains(&format!("offset={FETCH_PAGE_CHARS}")), "{rendered}");
    }

    #[test]
    fn offset_reads_the_next_part_to_the_end() {
        let rendered = render_fetched_page(&page_of(FETCH_PAGE_CHARS + 500), FETCH_PAGE_CHARS);
        assert!(!rendered.contains("unread"), "{rendered}");
        assert!(rendered.ends_with(&"a".repeat(500)));
    }

    #[test]
    fn offset_past_the_end_is_explained() {
        let rendered = render_fetched_page(&page_of(10), 99);
        assert!(rendered.contains("past the end"), "{rendered}");
    }

    #[test]
    fn cache_serves_within_ttl_and_expires() {
        let mut c = FetchCache::default();
        let t0 = Instant::now();
        c.put("u", page_of(3), t0);
        assert!(c.get("u", t0 + Duration::from_secs(60)).is_some());
        assert!(c.get("u", t0 + FETCH_CACHE_TTL + Duration::from_secs(1)).is_none());
    }

    #[test]
    fn cache_is_bounded_and_evicts_oldest() {
        let mut c = FetchCache::default();
        let t0 = Instant::now();
        for i in 0..FETCH_CACHE_MAX_ENTRIES + 3 {
            c.put(&format!("u{i}"), page_of(1), t0 + Duration::from_secs(i as u64));
        }
        assert_eq!(c.pages.len(), FETCH_CACHE_MAX_ENTRIES);
        let now = t0 + Duration::from_secs(100);
        assert!(c.get("u0", now).is_none());
        assert!(c.get(&format!("u{}", FETCH_CACHE_MAX_ENTRIES + 2), now).is_some());
    }

    /// Live smoke test against the keyless hosted endpoint. Ignored by default
    /// (needs network); run with `cargo test -- --ignored web_search_live`.
    #[tokio::test]
    #[ignore]
    async fn web_search_live_keyless() {
        let out = web_search(&json!({ "query": "capital of France", "count": 2 })).await;
        assert!(!out.starts_with("ERROR"), "unexpected error: {out}");
        assert!(out.to_lowercase().contains("paris"), "got: {out}");
    }
}
