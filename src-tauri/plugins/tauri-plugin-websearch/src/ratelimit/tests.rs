use super::*;
use crate::provider::ExaProvider;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The body Exa's free pool answered in the user report.
const EXA_429_BODY: &str = r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key. Fix: Create API key at https://dashboard.exa.ai/api-keys , then either: - Set the header: Authorization: Bearer ... Or use the URL: https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY"},"id":null}"#;

struct FakeClock {
    start: Instant,
    offset: Mutex<Duration>,
}

impl FakeClock {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            start: Instant::now(),
            offset: Mutex::new(Duration::ZERO),
        })
    }
    fn advance(&self, d: Duration) {
        *self.offset.lock().unwrap() += d;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Instant {
        self.start + *self.offset.lock().unwrap()
    }
}

/// A backend answering from a script, counting calls (= network requests).
struct Scripted {
    calls: Arc<AtomicUsize>,
    answers: Mutex<Vec<Result<(), String>>>,
}

#[async_trait]
impl SearchProvider for Scripted {
    async fn search(&self, _q: &str, _c: u32) -> Result<Vec<SearchResult>, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let next = self.answers.lock().unwrap().remove(0);
        next.map(|()| {
            vec![SearchResult {
                title: "t".into(),
                url: "https://example.com".into(),
                snippet: "s".into(),
                published_at: None,
            }]
        })
    }
    async fn fetch(&self, url: &str) -> Result<FetchedPage, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let next = self.answers.lock().unwrap().remove(0);
        next.map(|()| FetchedPage {
            url: url.into(),
            title: "t".into(),
            content: "c".into(),
            truncated: false,
        })
    }
}

fn scripted(
    name: &'static str,
    keyless: bool,
    answers: Vec<Result<(), String>>,
) -> (Gated, Arc<AtomicUsize>, Arc<FakeClock>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let clock = FakeClock::new();
    let gate = Arc::new(RateGate::new(clock.clone()));
    let inner = Scripted {
        calls: calls.clone(),
        answers: Mutex::new(answers),
    };
    (
        Gated::new(
            name,
            name.to_ascii_lowercase(),
            keyless,
            Box::new(inner),
            gate,
        ),
        calls,
        clock,
    )
}

fn assert_clean(msg: &str) {
    for bad in [
        "{",
        "jsonrpc",
        "Bearer",
        "Authorization",
        "exaApiKey",
        "api-keys",
        "different source",
        "http",
    ] {
        assert!(!msg.contains(bad), "{bad:?} leaked into: {msg}");
    }
}

/// Serves `status` + `body` (+ optional Retry-After) to every request and
/// counts the requests.
async fn fake_server(
    status: &'static str,
    retry_after: Option<&'static str>,
    body: &'static str,
) -> (String, Arc<AtomicUsize>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            let mut req = [0u8; 4096];
            let _ = sock.read(&mut req).await;
            let extra = retry_after.map_or(String::new(), |v| format!("Retry-After: {v}\r\n"));
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(body.as_bytes()).await;
        }
    });
    (format!("http://127.0.0.1:{port}/mcp"), hits)
}

fn gated_exa(url: &str, clock: Arc<FakeClock>) -> Gated {
    let exa = ExaProvider::new(None).unwrap().with_hosted_url(url);
    Gated::new(
        "Exa",
        "exa-hosted".into(),
        true,
        Box::new(exa),
        Arc::new(RateGate::new(clock)),
    )
}

#[tokio::test]
async fn the_reported_exa_429_becomes_one_plain_sentence_and_no_second_request() {
    let (url, hits) = fake_server("429 Too Many Requests", None, EXA_429_BODY).await;
    let clock = FakeClock::new();
    let exa = gated_exa(&url, clock.clone());

    let first = exa.fetch("https://example.com/a").await.unwrap_err();
    assert!(first.starts_with(RATE_LIMITED_PREFIX), "{first}");
    assert!(first.contains("Exa, HTTP 429"), "{first}");
    assert!(first.contains("about 30 seconds"), "{first}");
    assert!(first.contains("Do not retry before then"), "{first}");
    assert!(first.contains("Settings > Web Search"), "{first}");
    assert_clean(&first);
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // Within the cool-down: same message, no network.
    clock.advance(Duration::from_secs(10));
    let again = exa.search("q", 5).await.unwrap_err();
    assert!(again.starts_with(RATE_LIMITED_PREFIX), "{again}");
    assert!(again.contains("about 20 seconds"), "{again}");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "no request while the gate is closed"
    );

    // After it: the provider is asked again.
    clock.advance(Duration::from_secs(25));
    let _ = exa.search("q", 5).await;
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_retry_after_header_in_seconds_is_honoured() {
    let (url, hits) = fake_server("429 Too Many Requests", Some("600"), "{}").await;
    let clock = FakeClock::new();
    let exa = gated_exa(&url, clock.clone());
    let msg = exa.search("q", 5).await.unwrap_err();
    assert!(msg.contains("about 10 minutes"), "{msg}");
    clock.advance(Duration::from_secs(590));
    let again = exa.search("q", 5).await.unwrap_err();
    assert!(again.contains("about 10 seconds"), "{again}");
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_200_json_rpc_rate_limit_error_closes_the_gate() {
    let (url, hits) = fake_server("200 OK", None, EXA_429_BODY).await;
    let clock = FakeClock::new();
    let exa = gated_exa(&url, clock.clone());
    let msg = exa.search("q", 5).await.unwrap_err();
    assert!(msg.starts_with(RATE_LIMITED_PREFIX), "{msg}");
    assert_clean(&msg);
    let _ = exa.search("q", 5).await;
    assert_eq!(hits.load(Ordering::SeqCst), 1);
}

#[test]
fn retry_after_date_form_is_relative_to_now() {
    let now = httpdate::parse_http_date("Sun, 18 Oct 2026 12:00:00 GMT").unwrap();
    assert_eq!(
        parse_retry_after("Sun, 18 Oct 2026 12:02:00 GMT", now),
        Some(Duration::from_secs(120))
    );
    assert_eq!(
        parse_retry_after("Sun, 18 Oct 2026 11:00:00 GMT", now),
        Some(Duration::ZERO)
    );
    assert_eq!(
        parse_retry_after(" 45 ", now),
        Some(Duration::from_secs(45))
    );
    assert_eq!(parse_retry_after("soon", now), None);
}

#[test]
fn an_overlong_retry_after_is_clamped() {
    let gate = RateGate::new(FakeClock::new());
    let applied = gate.record_limit("x", Some(Duration::from_secs(86_400)));
    assert_eq!(applied, MAX_RETRY_AFTER);
}

#[test]
fn cooldown_grows_and_is_capped() {
    let secs: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs()).collect();
    assert_eq!(secs, vec![30, 60, 120, 240, 480, 900, 900, 900]);
    assert_eq!(backoff(u32::MAX), MAX_COOLDOWN);
}

#[tokio::test]
async fn repeated_limits_grow_and_a_success_resets() {
    let limit = || Err::<(), _>(rate_limited_marker("Exa", Some(429), None));
    let (g, calls, clock) = scripted("Exa", true, vec![limit(), limit(), Ok(()), limit()]);
    let m1 = g.search("q", 1).await.unwrap_err();
    assert!(m1.contains("about 30 seconds"), "{m1}");
    clock.advance(Duration::from_secs(31));
    let m2 = g.search("q", 1).await.unwrap_err();
    assert!(m2.contains("about 60 seconds"), "{m2}");
    clock.advance(Duration::from_secs(61));
    assert!(
        g.search("q", 1).await.is_ok(),
        "recovers once the clock passes"
    );
    let m3 = g.search("q", 1).await.unwrap_err();
    assert!(m3.contains("about 30 seconds"), "strikes reset: {m3}");
    assert_eq!(calls.load(Ordering::SeqCst), 4);
}

#[test]
fn rate_limit_variants_are_recognised() {
    assert!(api_http_error("X", 429, None, "").contains(MARKER));
    assert!(api_http_error("X", 503, None, "").contains(MARKER));
    assert!(api_http_error("X", 403, None, "Rate limit exceeded").contains(MARKER));
    assert!(api_http_error("X", 400, None, "{\"error\":\"Too Many Requests\"}").contains(MARKER));
    assert!(!api_http_error("X", 404, None, "not found").contains(MARKER));
    assert_eq!(
        api_http_error("X", 429, Some(Duration::from_secs(7)), ""),
        "X rate limited (HTTP 429; retry after 7s)"
    );
    assert!(is_rate_limit_error(
        "Tavily returned an error: rate-limit hit"
    ));
    assert_eq!(
        api_http_error("X", 500, None, "{\"secret\":1}"),
        "X failed with HTTP 500"
    );
}

#[tokio::test]
async fn a_keyed_provider_is_gated_the_same_and_never_switched() {
    let (g, calls, _clock) = scripted(
        "Tavily",
        false,
        vec![Err(rate_limited_marker(
            "Tavily",
            Some(429),
            Some(Duration::from_secs(120)),
        ))],
    );
    let msg = g.search("q", 1).await.unwrap_err();
    assert!(msg.contains("Tavily, HTTP 429"), "{msg}");
    assert!(msg.contains("about 2 minutes"), "{msg}");
    assert!(
        !msg.contains("Settings"),
        "the key hint is for the keyless default only: {msg}"
    );
    let again = g.search("q", 1).await.unwrap_err();
    assert!(again.contains("Tavily"), "{again}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn other_errors_are_sanitised_and_do_not_close_the_gate() {
    let raw = "Exa returned an error: see https://x.test/?apiKey=abc then Authorization: Bearer sk-1 {\"jsonrpc\":\"2.0\"}";
    let (g, calls, _c) = scripted("Exa", true, vec![Err(raw.into()), Ok(())]);
    let msg = g.fetch("https://e.test").await.unwrap_err();
    assert!(
        !msg.contains("apiKey") && !msg.contains("sk-1") && !msg.contains('{'),
        "{msg}"
    );
    assert!(!is_gate_message(&msg));
    assert!(g.fetch("https://e.test").await.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn local_address_refusals_keep_their_url() {
    let m = sanitize_error("refused to fetch http://[::1]/x: ::1 is a local or private address");
    assert!(m.contains("[::1]"), "{m}");
}
