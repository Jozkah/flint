use super::*;

/// A body that never delivers a byte, like a client that trickles.
struct Stalled;

impl hyper::body::Body for Stalled {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
        std::task::Poll::Pending
    }
}

#[tokio::test]
async fn login_body_trickle_times_out() {
    let result = collect_limited(Stalled, MAX_LOGIN_BODY, std::time::Duration::from_millis(50)).await;
    assert_eq!(result, Err(StatusCode::REQUEST_TIMEOUT));
}

#[tokio::test]
async fn collect_limited_enforces_size() {
    let deadline = std::time::Duration::from_secs(5);
    let ok = collect_limited(Full::new(Bytes::from_static(b"abcd")), 4, deadline).await;
    assert_eq!(ok, Ok(Bytes::from_static(b"abcd")));
    let big = collect_limited(Full::new(Bytes::from_static(b"abcde")), 4, deadline).await;
    assert_eq!(big, Err(StatusCode::PAYLOAD_TOO_LARGE));
}

#[test]
fn cookie_parser_requires_exact_hex_session() {
    let mut headers = hyper::HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_static("flint_session=short"),
    );
    assert!(session_cookie(&headers).is_none());
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("other=x; flint_session={}", "a".repeat(64))).unwrap(),
    );
    assert_eq!(session_cookie(&headers), Some("a".repeat(64).as_str()));
}

#[test]
fn origins_must_name_configured_host() {
    let dir = tempfile::tempdir().unwrap();
    let (auth, _) = AuthStore::open(dir.path().join("auth.json")).unwrap();
    let state = State {
        auth: Mutex::new(auth),
        assets: dir.path().to_path_buf(),
        data_folder: dir.path().to_path_buf(),
        hosts: HashSet::from(["localhost:1340".to_string()]),
        public_host: None,
        limiter: LoginLimiter::new(),
        mcp: mcp::Host::new(false),
        agent: None,
        allowed_origins: HashSet::new(),
        engine: engine::Supervisor::new(None, events::Bus::new()),
        settings: settings::Store::new(dir.path()),
        events: events::Bus::new(),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        shutdown_token: String::new(),
        trust_proxy: false,
    };
    let mut headers = hyper::HeaderMap::new();
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://localhost:1340"),
    );
    assert!(same_origin(&state, &headers));
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://evil.example"),
    );
    assert!(!same_origin(&state, &headers));
}

#[tokio::test]
async fn non_loopback_bind_needs_an_allowed_host() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "ok").unwrap();
    let error = serve(Options {
        bind: "0.0.0.0:0".parse().unwrap(),
        assets: dir.path().to_path_buf(),
        data_folder: dir.path().to_path_buf(),
        auth_file: dir.path().join("auth.json"),
        public_host: None,
        allow_mcp_stdio: false,
        trust_proxy: false,
        agent_roots: Vec::new(),
        agent_run: false,
        agent_runner: Default::default(),
        allowed_hosts: Vec::new(),
        allowed_origins: Vec::new(),
        llama_worker: None,
        credential_file: None,
    })
    .await
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn host_and_origin_entries_are_exact() {
    for good in ["phone.tail1234.ts.net", "192.168.1.5:1340", "localhost", "[fd7a::1]:1340"] {
        assert!(valid_host_entry(good), "{good}");
    }
    for bad in ["", "*", "*.example.com", "http://x", "a/b", "a:b", "host:", "a b", "[nope]:1"] {
        assert!(!valid_host_entry(bad), "{bad}");
    }
    assert!(valid_origin_entry("https://app.example.com"));
    assert!(valid_origin_entry("http://tauri.localhost"));
    for bad in ["*", "null", "https://*", "tauri://localhost", "https://a.b/path", "https://"] {
        assert!(!valid_origin_entry(bad), "{bad}");
    }
}

#[test]
fn bearer_tokens_are_exact_hex_and_only_that_scheme() {
    let mut headers = hyper::HeaderMap::new();
    let token = "ab".repeat(32);
    headers.insert(header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {token}")).unwrap());
    assert_eq!(bearer_token(&headers), Some(token.as_str()));
    headers.insert(header::AUTHORIZATION, HeaderValue::from_str(&format!("bearer {token}")).unwrap());
    assert!(bearer_token(&headers).is_some());
    for bad in ["Basic abc", "Bearer short", &format!("Bearer {}g", "a".repeat(63)), &token] {
        headers.insert(header::AUTHORIZATION, HeaderValue::from_str(bad).unwrap());
        assert!(bearer_token(&headers).is_none(), "{bad}");
    }
}

#[tokio::test]
async fn serving_beyond_loopback_needs_hosts_and_valid_entries() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "ok").unwrap();
    let options = |hosts: Vec<&str>, origins: Vec<&str>| Options {
        bind: "0.0.0.0:0".parse().unwrap(),
        assets: dir.path().to_path_buf(),
        data_folder: dir.path().to_path_buf(),
        auth_file: dir.path().join("auth.json"),
        public_host: None,
        allow_mcp_stdio: false,
        trust_proxy: false,
        agent_roots: Vec::new(),
        agent_run: false,
        agent_runner: Default::default(),
        allowed_hosts: hosts.into_iter().map(String::from).collect(),
        allowed_origins: origins.into_iter().map(String::from).collect(),
        llama_worker: None,
        credential_file: None,
    };
    let none = serve(options(vec![], vec![])).await.unwrap_err();
    assert!(none.to_string().contains("--allowed-host"));
    let wildcard = serve(options(vec!["*"], vec![])).await.unwrap_err();
    assert!(wildcard.to_string().contains("--allowed-host"));
    let origin = serve(options(vec!["phone.example"], vec!["*"])).await.unwrap_err();
    assert!(origin.to_string().contains("--allowed-origin"));
}

#[test]
fn the_phone_client_is_not_served_and_says_why() {
    for path in ["/m", "/m/", "/m/index.html", "/remote/v1/rpc", "/remote/v1/events"] {
        let resp = phone_client_page(path).unwrap_or_else(|| panic!("{path} must be answered"));
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{path}");
    }
    for path in ["/", "/mcp", "/models", "/api/v1/rpc/x", "/remote-x"] {
        assert!(phone_client_page(path).is_none(), "{path}");
    }
    assert!(PHONE_NOT_HERE_HTML.contains("needs the Flint desktop app"));
}

#[test]
fn cors_applies_only_to_listed_origins() {
    let dir = tempfile::tempdir().unwrap();
    let (auth, _) = AuthStore::open(dir.path().join("auth.json")).unwrap();
    let state = State {
        auth: Mutex::new(auth),
        assets: dir.path().to_path_buf(),
        data_folder: dir.path().to_path_buf(),
        hosts: HashSet::new(),
        public_host: None,
        limiter: LoginLimiter::new(),
        mcp: mcp::Host::new(false),
        agent: None,
        allowed_origins: HashSet::from(["http://tauri.localhost".to_string()]),
        engine: engine::Supervisor::new(None, events::Bus::new()),
        settings: settings::Store::new(dir.path()),
        events: events::Bus::new(),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        shutdown_token: String::new(),
        trust_proxy: false,
    };
    let mut headers = hyper::HeaderMap::new();
    headers.insert(header::ORIGIN, HeaderValue::from_static("http://Tauri.localhost"));
    assert_eq!(cors_origin(&state, &headers).as_deref(), Some("http://tauri.localhost"));
    headers.insert(header::ORIGIN, HeaderValue::from_static("http://evil.example"));
    assert!(cors_origin(&state, &headers).is_none());
    let response = with_cors(text(StatusCode::OK, "x"), Some("http://tauri.localhost"));
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "http://tauri.localhost"
    );
    assert!(response.headers().get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
    let none = with_cors(text(StatusCode::OK, "x"), None);
    assert!(none.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
}

#[test]
fn session_cookie_is_secure_for_https_origins_on_known_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let (auth, _) = AuthStore::open(dir.path().join("auth.json")).unwrap();
    let state = State {
        auth: Mutex::new(auth),
        assets: dir.path().to_path_buf(),
        data_folder: dir.path().to_path_buf(),
        hosts: HashSet::from(["box.ts.net:8443".to_string(), "localhost:1340".to_string()]),
        public_host: Some("box.ts.net".to_string()),
        limiter: LoginLimiter::new(),
        mcp: mcp::Host::new(false),
        agent: None,
        allowed_origins: HashSet::new(),
        engine: engine::Supervisor::new(None, events::Bus::new()),
        settings: settings::Store::new(dir.path()),
        events: events::Bus::new(),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        shutdown_token: String::new(),
        trust_proxy: false,
    };
    let mut headers = hyper::HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("box.ts.net:8443"));
    headers.insert(header::ORIGIN, HeaderValue::from_static("https://box.ts.net:8443"));
    assert!(cookie_secure(&state, &headers));
    headers.insert(header::ORIGIN, HeaderValue::from_static("http://localhost:1340"));
    headers.insert(header::HOST, HeaderValue::from_static("localhost:1340"));
    assert!(!cookie_secure(&state, &headers));
    headers.insert(header::ORIGIN, HeaderValue::from_static("https://evil.example"));
    assert!(!cookie_secure(&state, &headers));
    headers.insert(header::HOST, HeaderValue::from_static("box.ts.net"));
    headers.remove(header::ORIGIN);
    assert!(cookie_secure(&state, &headers));
}

#[test]
fn the_login_page_shows_a_notice_chosen_here_never_one_from_the_request() {
    assert!(!login_page(None).contains("class=\"notice\""));
    let shown = login_page(Some("invalid"));
    assert!(shown.contains(r#"<p class="notice" role="alert">That credential is not right."#));
    assert!(login_page(Some("rate")).contains("Too many attempts"));
    let hostile = login_page(Some("<script>alert(1)</script>"));
    assert!(!hostile.contains("<script>alert"));
    assert!(!hostile.contains("class=\"notice\""));
    assert!(login_page(None).contains("action=\"/api/v1/session\""));
    assert!(!login_page(None).contains("{{"));
}

#[test]
fn html_policy_allows_app_styles_but_blocks_foreign_scripts() {
    let response = reply(StatusCode::OK, "text/html", "ok");
    let policy = response
        .headers()
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(policy.contains("style-src 'self' 'unsafe-inline'"));
    assert!(policy.contains("script-src 'self'"));
    assert!(policy.contains("object-src 'none'"));
}
