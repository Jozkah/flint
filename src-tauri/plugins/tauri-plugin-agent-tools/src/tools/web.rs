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

use futures_util::future::join_all;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri_plugin_websearch::provider::{
    clamp_count, create_provider, FetchedPage, SearchProvider, SearchResult,
};

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

/// Most queries / URLs one `web_search` / `web_fetch` call may carry.
const MAX_BATCH: usize = 5;
/// How many of a batch run at once.
const BATCH_CONCURRENCY: usize = 4;
/// Longest one query or URL may take inside a batch before it is reported as
/// failed (the other entries are unaffected).
const BATCH_ITEM_TIMEOUT: Duration = Duration::from_secs(30);
/// Characters a multi-query `web_search` result may hold in total.
const MULTI_SEARCH_MAX_CHARS: usize = 24_000;

/// Read `single` and the `plural` string array from `args` into one trimmed,
/// de-duplicated, ordered list. `Ok(empty)` means neither was given.
fn collect_batch(args: &Value, single: &str, plural: &str, tool: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str, key: &str| -> Result<(), String> {
        let v = raw.trim();
        if v.is_empty() {
            return Err(format!("ERROR: {tool} '{key}' must not be empty."));
        }
        if !out.iter().any(|x| x == v) {
            out.push(v.to_string());
        }
        Ok(())
    };
    match args.get(single) {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => push(s, single)?,
        Some(_) => return Err(format!("ERROR: {tool} requires a '{single}' string argument.")),
    }
    match args.get(plural) {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            for it in items {
                let Some(s) = it.as_str() else {
                    return Err(format!("ERROR: {tool} '{plural}' must be an array of strings."));
                };
                push(s, plural)?;
            }
        }
        Some(_) => return Err(format!("ERROR: {tool} '{plural}' must be an array of strings.")),
    }
    if out.len() > MAX_BATCH {
        return Err(format!(
            "ERROR: {tool} accepts at most {MAX_BATCH} entries in '{plural}', got {}.",
            out.len()
        ));
    }
    Ok(out)
}

/// Execute the `web_search` built-in. Returns the tool-result text; errors are
/// returned as a `String` starting with "ERROR" to match the other handlers.
/// `query` searches once; `queries` (up to 5) searches concurrently and groups
/// the results per query.
pub async fn web_search(args: &Value) -> String {
    let queries = match collect_batch(args, "query", "queries", "web_search") {
        Ok(q) => q,
        Err(e) => return e,
    };
    if queries.is_empty() {
        return if args.get("query").is_some() || args.get("queries").is_some() {
            "ERROR: web_search needs at least one non-empty query.".to_string()
        } else {
            "ERROR: web_search requires a 'query' string argument.".to_string()
        };
    }
    let count = clamp_count(args.get("count").and_then(|v| v.as_u64()));
    let provider = match create_provider(None, exa_api_key(), None) {
        Ok(p) => p,
        Err(e) => return e,
    };
    search_with(provider.as_ref(), &queries, count).await
}

async fn search_with(provider: &dyn SearchProvider, queries: &[String], count: u32) -> String {
    if let [query] = queries {
        return match provider.search(query, count).await {
            Ok(results) if results.is_empty() => {
                format!("No web search results found for query: {query}")
            }
            Ok(results) => render_search_results(&results),
            Err(e) => format!("ERROR: {e}"),
        };
    }
    // Entries run through the same (rate-limited) provider, at most
    // BATCH_CONCURRENCY at a time, results kept in the model's order.
    let mut outcomes: Vec<Result<Vec<SearchResult>, String>> = Vec::new();
    for chunk in queries.chunks(BATCH_CONCURRENCY) {
        outcomes.extend(
            join_all(chunk.iter().map(|q| async move {
                match tokio::time::timeout(BATCH_ITEM_TIMEOUT, provider.search(q, count)).await {
                    Ok(r) => r,
                    Err(_) => Err(format!("timed out after {}s", BATCH_ITEM_TIMEOUT.as_secs())),
                }
            }))
            .await,
        );
    }
    render_multi_search(queries, outcomes)
}

fn render_multi_search(
    queries: &[String],
    outcomes: Vec<Result<Vec<SearchResult>, String>>,
) -> String {
    let mut seen = std::collections::HashSet::new();
    let failed = outcomes.iter().filter(|o| o.is_err()).count();
    let mut out = String::new();
    if failed == queries.len() {
        out.push_str(&format!("ERROR: all {failed} searches failed.\n\n"));
    }
    for (q, outcome) in queries.iter().zip(outcomes) {
        out.push_str(&format!("## Query: {q}\n"));
        match outcome {
            Err(e) => out.push_str(&format!("ERROR: {e}\n\n")),
            Ok(results) if results.is_empty() => out.push_str("No results.\n\n"),
            Ok(results) => {
                let fresh: Vec<SearchResult> = results
                    .into_iter()
                    .filter(|r| seen.insert(r.url.trim_end_matches('/').to_string()))
                    .collect();
                if fresh.is_empty() {
                    out.push_str("(all results were already listed under an earlier query)\n\n");
                } else {
                    out.push_str(&render_search_results(&fresh));
                    out.push_str("\n\n");
                }
            }
        }
    }
    let out = out.trim_end().to_string();
    if out.chars().count() > MULTI_SEARCH_MAX_CHARS {
        let cut: String = out.chars().take(MULTI_SEARCH_MAX_CHARS).collect();
        return format!("{cut}\n\n[output cut at {MULTI_SEARCH_MAX_CHARS} characters; search again with fewer queries or a smaller count to see the rest]");
    }
    out
}

/// Execute the `web_fetch` built-in. Returns bounded readable content with its
/// source URL/title; errors start with "ERROR". `urls` (up to 5) fetches
/// concurrently and shares one character budget between the pages.
pub async fn web_fetch(args: &Value, read_roots: &[std::path::PathBuf]) -> String {
    let urls = match collect_batch(args, "url", "urls", "web_fetch") {
        Ok(u) => u,
        Err(e) => return e,
    };
    if urls.is_empty() {
        return if args.get("url").is_some() || args.get("urls").is_some() {
            "ERROR: web_fetch needs at least one non-empty url.".to_string()
        } else {
            "ERROR: web_fetch requires a 'url' string argument.".to_string()
        };
    }
    let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    if urls.len() > 1 && offset > 0 {
        return "ERROR: web_fetch 'offset' only works with a single 'url'; fetch the page on its own to read further.".to_string();
    }
    if let [url] = urls.as_slice() {
        if !is_http(url) {
            return format!("ERROR: web_fetch 'url' must be an http(s) URL, got: {url}");
        }
    }
    let provider = match create_provider(None, exa_api_key(), None) {
        Ok(p) => p,
        Err(e) => return e,
    };
    fetch_with(provider.as_ref(), &urls, offset, read_roots).await
}

fn is_http(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

async fn fetch_with(
    provider: &dyn SearchProvider,
    urls: &[String],
    offset: usize,
    read_roots: &[std::path::PathBuf],
) -> String {
    if let [url] = urls {
        return fetch_one(provider, url, offset, FETCH_PAGE_CHARS, read_roots).await;
    }
    let window = FETCH_PAGE_CHARS / urls.len();
    let mut pages: Vec<String> = Vec::new();
    for chunk in urls.chunks(BATCH_CONCURRENCY) {
        pages.extend(
            join_all(chunk.iter().map(|u| async move {
                if !is_http(u) {
                    return format!("ERROR: web_fetch url must be an http(s) URL, got: {u}");
                }
                match tokio::time::timeout(
                    BATCH_ITEM_TIMEOUT,
                    fetch_one(provider, u, 0, window, read_roots),
                )
                .await
                {
                    Ok(s) => s,
                    Err(_) => format!("ERROR: timed out after {}s", BATCH_ITEM_TIMEOUT.as_secs()),
                }
            }))
            .await,
        );
    }
    urls.iter()
        .zip(pages)
        .map(|(u, p)| format!("## {u}\n{p}"))
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn fetch_one(
    provider: &dyn SearchProvider,
    url: &str,
    offset: usize,
    window: usize,
    read_roots: &[std::path::PathBuf],
) -> String {
    let cached = fetch_cache()
        .lock()
        .ok()
        .and_then(|mut c| c.get(url, Instant::now()));
    if let Some(page) = cached {
        return render_fetched_window(&page, offset, window);
    }
    match provider.fetch(url).await {
        Ok(page) => {
            if let Ok(mut c) = fetch_cache().lock() {
                c.put(url, page.clone(), Instant::now());
            }
            render_fetched_window(&page, offset, window)
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
#[cfg(test)]
fn render_fetched_page(page: &FetchedPage, offset: usize) -> String {
    render_fetched_window(page, offset, FETCH_PAGE_CHARS)
}

fn render_fetched_window(page: &FetchedPage, offset: usize, window_chars: usize) -> String {
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
        .take(window_chars)
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

    // ---- batch (parallel) behaviour, against a fake backend ----

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Default)]
    struct Fake {
        in_flight: AtomicUsize,
        peak: AtomicUsize,
        delay_ms: u64,
    }

    #[async_trait::async_trait]
    impl SearchProvider for Fake {
        async fn search(&self, query: &str, _count: u32) -> Result<Vec<SearchResult>, String> {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            if query.starts_with("fail") {
                return Err(format!("backend down for {query}"));
            }
            let shared = SearchResult {
                title: "Shared".into(),
                url: "https://shared.example/".into(),
                snippet: "s".into(),
                published_at: None,
            };
            let own = SearchResult {
                title: format!("Own {query}"),
                url: format!("https://own.example/{query}"),
                snippet: "x".repeat(if query.starts_with("big") { 20_000 } else { 3 }),
                published_at: None,
            };
            Ok(vec![shared, own])
        }
        async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            if url.contains("broken") {
                return Err("503".into());
            }
            Ok(FetchedPage {
                url: url.into(),
                title: "T".into(),
                content: "p".repeat(30_000),
                truncated: false,
            })
        }
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn batch_args_are_validated() {
        let ok = collect_batch(&json!({"query": "a", "queries": ["b", "a", " c "]}), "query", "queries", "web_search").unwrap();
        assert_eq!(ok, strings(&["a", "b", "c"]));
        let too_many = json!({"queries": ["1", "2", "3", "4", "5", "6"]});
        assert!(collect_batch(&too_many, "query", "queries", "web_search").unwrap_err().contains("at most 5"));
        assert!(collect_batch(&json!({"queries": ["a", ""]}), "query", "queries", "web_search").is_err());
        assert!(collect_batch(&json!({"queries": [1]}), "query", "queries", "web_search").is_err());
        assert!(collect_batch(&json!({"queries": "a"}), "query", "queries", "web_search").is_err());
        assert!(collect_batch(&json!({}), "query", "queries", "web_search").unwrap().is_empty());
    }

    #[tokio::test]
    async fn batch_entry_points_reject_bad_args() {
        assert!(web_search(&json!({"queries": []})).await.starts_with("ERROR"));
        assert!(web_search(&json!({"queries": ["a","b","c","d","e","f"]})).await.contains("at most 5"));
        assert!(web_fetch(&json!({"urls": ["https://a.example", "https://b.example"], "offset": 5}), &[])
            .await
            .contains("offset"));
        assert!(web_fetch(&json!({"urls": []}), &[]).await.starts_with("ERROR"));
    }

    #[tokio::test]
    async fn single_query_output_is_unchanged() {
        let out = search_with(&Fake::default(), &strings(&["q"]), 5).await;
        assert!(out.starts_with("1. Shared"), "{out}");
        assert!(!out.contains("## Query"));
    }

    #[tokio::test]
    async fn multi_search_groups_dedupes_and_keeps_order() {
        let out = search_with(&Fake::default(), &strings(&["one", "two"]), 5).await;
        let (a, b) = (out.find("## Query: one").unwrap(), out.find("## Query: two").unwrap());
        assert!(a < b);
        assert_eq!(out.matches("https://shared.example/").count(), 1, "{out}");
        assert!(out.contains("https://own.example/one") && out.contains("https://own.example/two"));
    }

    #[tokio::test]
    async fn partial_failure_keeps_good_results() {
        let out = search_with(&Fake::default(), &strings(&["one", "fail1"]), 5).await;
        assert!(!out.starts_with("ERROR"), "{out}");
        assert!(out.contains("https://own.example/one"));
        assert!(out.contains("backend down for fail1"));
        let all = search_with(&Fake::default(), &strings(&["fail1", "fail2"]), 5).await;
        assert!(all.starts_with("ERROR: all 2 searches failed"), "{all}");
    }

    #[tokio::test]
    async fn multi_search_total_is_capped() {
        let out = search_with(&Fake::default(), &strings(&["big1", "big2", "big3"]), 5).await;
        assert!(out.contains("[output cut at"), "len {}", out.len());
        assert!(out.chars().count() < MULTI_SEARCH_MAX_CHARS + 300);
    }

    #[tokio::test]
    async fn concurrency_is_bounded() {
        let fake = Arc::new(Fake { delay_ms: 40, ..Default::default() });
        let qs = strings(&["a", "b", "c", "d", "e"]);
        search_with(fake.as_ref(), &qs, 5).await;
        let peak = fake.peak.load(Ordering::SeqCst);
        assert!(peak > 1, "no parallelism, peak {peak}");
        assert!(peak <= BATCH_CONCURRENCY, "peak {peak}");
    }

    #[tokio::test]
    async fn multi_fetch_shares_budget_and_reports_per_url_errors() {
        let urls = strings(&[
            "https://batch-a.example/p",
            "https://batch-a.example/broken",
            "ftp://nope",
        ]);
        let out = fetch_with(&Fake::default(), &urls, 0, &[]).await;
        assert!(out.contains("## https://batch-a.example/p\nTitle: T"), "{out}");
        assert!(out.contains("ERROR: 503"));
        assert!(out.contains("must be an http(s) URL"));
        // 40k shared across 3 pages: each window is a third of it.
        assert!(out.contains(&format!("showing characters 0-{}", FETCH_PAGE_CHARS / 3)), "{out}");
    }

    #[tokio::test]
    async fn multi_fetch_concurrency_is_bounded() {
        let fake = Fake { delay_ms: 40, ..Default::default() };
        let urls: Vec<String> = (0..5).map(|i| format!("https://batch-c.example/{i}")).collect();
        fetch_with(&fake, &urls, 0, &[]).await;
        let peak = fake.peak.load(Ordering::SeqCst);
        assert!(peak > 1 && peak <= BATCH_CONCURRENCY, "peak {peak}");
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
