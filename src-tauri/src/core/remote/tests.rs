use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use super::auth::*;
use super::config::*;
use super::hub::*;
use super::server;
use super::static_files::{self, StaticError};

const IP: IpAddr = IpAddr::V4(Ipv4Addr::new(100, 64, 0, 9));

#[derive(Default)]
struct Recorder {
    rpcs: Mutex<Vec<RpcRequestEvent>>,
    pairings: Mutex<Vec<PairingRequestEvent>>,
    window: bool,
}

impl Frontend for Recorder {
    fn rpc(&self, req: &RpcRequestEvent) -> bool {
        self.rpcs.lock().unwrap().push(req.clone());
        self.window
    }
    fn pairing_request(&self, req: &PairingRequestEvent) {
        self.pairings.lock().unwrap().push(req.clone());
    }
    fn devices_changed(&self) {}
}

fn hub_with(cfg: RemoteConfig) -> (Arc<RemoteHub>, Arc<Recorder>) {
    let rec = Arc::new(Recorder {
        window: true,
        ..Default::default()
    });
    let hub = Arc::new(RemoteHub::new(
        cfg,
        DeviceStore::in_memory(),
        rec.clone(),
        None,
    ));
    (hub, rec)
}

fn hub() -> (Arc<RemoteHub>, Arc<Recorder>) {
    hub_with(RemoteConfig::default())
}

/// Pairs a device end to end through the hub and returns its token.
fn pair(hub: &RemoteHub, name: &str) -> (String, String) {
    let start = hub.start_pairing();
    let claim = hub.claim_pairing(IP, &start.code, name).unwrap();
    let device = hub
        .confirm_pairing(&claim.request_id, true)
        .unwrap()
        .unwrap();
    match hub.poll_pairing(IP, &claim.poll_id) {
        PollResult::Approved { token, device_id } => {
            assert_eq!(device_id, device.id);
            (token, device.id)
        }
        other => panic!("expected approval, got {other:?}"),
    }
}

// -- tokens -------------------------------------------------------------------

#[test]
fn tokens_are_32_random_bytes_base64url() {
    let a = generate_token();
    let b = generate_token();
    assert_ne!(a, b);
    assert_eq!(a.len(), 43); // 32 bytes, unpadded base64url
    assert!(a
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
}

#[test]
fn only_the_hash_is_stored_and_verification_uses_it() {
    let mut store = DeviceStore::in_memory();
    let (device, token) = store.add("Pixel 9");
    assert_eq!(device.token_hash, hash_token(&token));
    assert_ne!(device.token_hash, token);
    assert_eq!(store.verify(&token).map(|d| d.id), Some(device.id));
    assert!(store.verify("not-a-token").is_none());
    assert!(store.verify("").is_none());
}

#[test]
fn stored_file_has_no_token() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("devices.json");
    let mut store = DeviceStore::load(path.clone());
    let (_, token) = store.add("Phone");
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(!raw.contains(&token));
    assert!(raw.contains(&hash_token(&token)));
    // And it loads back.
    assert!(DeviceStore::load(path).verify(&token).is_some());
}

#[test]
fn constant_time_eq_basics() {
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
    assert!(!constant_time_eq(b"abc", b"abcd"));
}

#[test]
fn device_names_are_cleaned() {
    assert_eq!(clean_device_name("  Pixel\u{7} 9 \n"), "Pixel 9");
    assert_eq!(clean_device_name(""), "Phone");
    assert_eq!(
        clean_device_name(&"x".repeat(200)).chars().count(),
        MAX_DEVICE_NAME_CHARS
    );
}

// -- pairing ------------------------------------------------------------------

#[test]
fn confirmation_number_is_six_digits_and_derived() {
    let n = confirmation_number("abc");
    assert_eq!(n.len(), 6);
    assert!(n.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(n, confirmation_number("abc"));
}

#[test]
fn pairing_code_expires() {
    let mut book = PairingBook::default();
    let t0 = Instant::now();
    let start = book.start(t0);
    assert_eq!(
        book.claim(&start.code, "p", t0 + PAIRING_TTL + Duration::from_secs(1)),
        Err(PairError::InvalidCode)
    );
}

#[test]
fn pairing_code_is_single_use() {
    let mut book = PairingBook::default();
    let t0 = Instant::now();
    let start = book.start(t0);
    assert!(book.claim(&start.code, "first", t0).is_ok());
    assert_eq!(
        book.claim(&start.code, "second", t0),
        Err(PairError::InvalidCode)
    );
}

#[test]
fn wrong_code_is_refused_and_does_not_consume_the_real_one() {
    let mut book = PairingBook::default();
    let t0 = Instant::now();
    let start = book.start(t0);
    assert_eq!(book.claim("guess", "p", t0), Err(PairError::InvalidCode));
    assert!(book.claim(&start.code, "p", t0).is_ok());
}

#[test]
fn a_new_code_replaces_the_old_one() {
    let mut book = PairingBook::default();
    let t0 = Instant::now();
    let old = book.start(t0);
    let _new = book.start(t0);
    assert_eq!(book.claim(&old.code, "p", t0), Err(PairError::InvalidCode));
}

#[test]
fn nothing_is_issued_until_the_desktop_confirms() {
    let mut book = PairingBook::default();
    let t0 = Instant::now();
    let start = book.start(t0);
    let claim = book.claim(&start.code, "Pixel", t0).unwrap();
    assert_eq!(claim.confirm_number, start.confirm_number);
    assert_eq!(book.poll(&claim.poll_id, t0), PollResult::Pending);
    // A wrong poll id learns nothing.
    assert_eq!(book.poll("other", t0), PollResult::Expired);
    let mut store = DeviceStore::in_memory();
    let device = book
        .confirm(&claim.request_id, true, t0, |n| store.add(n))
        .unwrap()
        .unwrap();
    assert_eq!(device.name, "Pixel");
    let token = match book.poll(&claim.poll_id, t0) {
        PollResult::Approved { token, .. } => token,
        other => panic!("{other:?}"),
    };
    assert!(store.verify(&token).is_some());
    // The token is handed out once.
    assert_eq!(book.poll(&claim.poll_id, t0), PollResult::Expired);
}

#[test]
fn rejected_pairing_issues_nothing() {
    let mut book = PairingBook::default();
    let t0 = Instant::now();
    let start = book.start(t0);
    let claim = book.claim(&start.code, "p", t0).unwrap();
    let mut added = false;
    assert_eq!(
        book.confirm(&claim.request_id, false, t0, |n| {
            added = true;
            DeviceStore::in_memory().add(n)
        }),
        Ok(None)
    );
    assert!(!added);
    assert_eq!(book.poll(&claim.poll_id, t0), PollResult::Rejected);
}

#[test]
fn unconfirmed_claim_expires() {
    let mut book = PairingBook::default();
    let t0 = Instant::now();
    let start = book.start(t0);
    let claim = book.claim(&start.code, "p", t0).unwrap();
    let late = t0 + CONFIRM_TTL + Duration::from_secs(1);
    assert_eq!(
        book.confirm(&claim.request_id, true, late, |n| DeviceStore::in_memory()
            .add(n)),
        Err(PairError::NoSuchRequest)
    );
}

#[test]
fn confirm_with_wrong_request_id_fails() {
    let mut book = PairingBook::default();
    let t0 = Instant::now();
    let start = book.start(t0);
    book.claim(&start.code, "p", t0).unwrap();
    assert_eq!(
        book.confirm("nope", true, t0, |n| DeviceStore::in_memory().add(n)),
        Err(PairError::NoSuchRequest)
    );
}

#[test]
fn hub_pairing_notifies_the_window() {
    let (hub, rec) = hub();
    let (token, _) = pair(&hub, "Pixel 9");
    let seen = rec.pairings.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].device_name, "Pixel 9");
    assert!(hub.authenticate(Some(&token), IP).is_some());
}

// -- revoke / auth ------------------------------------------------------------

#[test]
fn revoked_token_stops_working() {
    let (hub, _) = hub();
    let (token, id) = pair(&hub, "p");
    let mut rx = hub.subscribe_revocations();
    assert!(hub.revoke(&id));
    assert_eq!(rx.try_recv().unwrap(), id);
    assert!(hub.authenticate(Some(&token), IP).is_none());
    assert!(!hub.revoke(&id));
}

#[test]
fn repeated_auth_failures_block_the_ip() {
    let (hub, _) = hub();
    let other: IpAddr = "100.64.0.10".parse().unwrap();
    for _ in 0..AUTH_FAIL_LIMIT {
        assert!(!hub.is_blocked(IP));
        hub.authenticate(Some("wrong"), IP);
    }
    assert!(hub.is_blocked(IP));
    assert!(!hub.is_blocked(other));
}

// -- rate limit ---------------------------------------------------------------

#[test]
fn rate_limiter_window_slides() {
    let mut rl = RateLimiter::new(3, Duration::from_secs(10));
    let t0 = Instant::now();
    assert!(rl.hit(IP, t0));
    assert!(rl.hit(IP, t0));
    assert!(rl.hit(IP, t0));
    assert!(!rl.hit(IP, t0));
    assert!(rl.is_blocked(IP, t0));
    assert!(rl.hit(IP, t0 + Duration::from_secs(10)));
}

#[test]
fn pairing_attempts_are_rate_limited() {
    let (hub, _) = hub();
    hub.start_pairing();
    for _ in 0..PAIR_LIMIT {
        assert_eq!(
            hub.claim_pairing(IP, "guess", "p").unwrap_err(),
            ClaimError::InvalidCode
        );
    }
    assert_eq!(
        hub.claim_pairing(IP, "guess", "p").unwrap_err(),
        ClaimError::RateLimited
    );
}

// -- policy / rpc -------------------------------------------------------------

#[test]
fn method_names_are_validated() {
    assert!(valid_method("sessions.list"));
    assert!(valid_method("status"));
    assert!(!valid_method(""));
    assert!(!valid_method("Sessions"));
    assert!(!valid_method("a/b"));
    assert!(!valid_method(&"a".repeat(65)));
}

#[test]
fn approvals_policy_is_enforced() {
    let mut cfg = RemoteConfig::default();
    let once = json!({ "scope": "once" });
    let always = json!({ "scope": "always" });
    assert!(check_policy("sessions.list", &always, &cfg).is_ok());
    assert!(check_policy("approvals.respond", &once, &cfg).is_ok());
    assert!(check_policy("approvals.respond", &always, &cfg).is_err());
    assert!(check_policy("approvals.alwaysAllow", &once, &cfg).is_err());
    cfg.allow_always_allow = true;
    assert!(check_policy("approvals.respond", &always, &cfg).is_ok());
    cfg.allow_approvals = false;
    assert!(check_policy("approvals.respond", &once, &cfg).is_err());
    assert!(check_policy("approvals.list", &Value::Null, &cfg).is_err());
}

#[tokio::test]
async fn rpc_round_trips_through_the_window() {
    let (hub, rec) = hub();
    let (token, _) = pair(&hub, "p");
    let device = hub.authenticate(Some(&token), IP).unwrap();
    let h = hub.clone();
    let call = tokio::spawn(async move { h.rpc(&device, "status", json!({})).await });
    // Wait for the window to be asked.
    let id = loop {
        if let Some(r) = rec.rpcs.lock().unwrap().first() {
            break r.id.clone();
        }
        tokio::task::yield_now().await;
    };
    assert!(hub.respond(&id, Ok(json!({ "ok": 1 }))));
    assert_eq!(call.await.unwrap().unwrap().unwrap(), json!({ "ok": 1 }));
    // A second answer finds nothing waiting.
    assert!(!hub.respond(&id, Ok(Value::Null)));
}

#[tokio::test]
async fn rpc_times_out_and_forbidden_never_reaches_the_window() {
    let (hub, rec) = hub();
    let (token, _) = pair(&hub, "p");
    let device = hub.authenticate(Some(&token), IP).unwrap();
    let r = hub
        .rpc_with_timeout(&device, "status", json!({}), Duration::from_millis(20))
        .await;
    assert_eq!(r.unwrap_err(), RpcReject::Timeout);
    let n = rec.rpcs.lock().unwrap().len();
    let r = hub
        .rpc(&device, "approvals.respond", json!({ "scope": "always" }))
        .await;
    assert!(matches!(r, Err(RpcReject::Forbidden(_))));
    assert_eq!(rec.rpcs.lock().unwrap().len(), n);
}

// -- static files -------------------------------------------------------------

#[test]
fn static_paths_cannot_escape_the_root() {
    for bad in [
        "../secret",
        "a/../../b",
        "%2e%2e/x",
        "..%2fx",
        "a\\..\\b",
        "C:/x",
        "%00",
        "%zz",
    ] {
        assert_eq!(
            static_files::sanitize(bad),
            Err(StaticError::Forbidden),
            "{bad}"
        );
    }
    assert_eq!(
        static_files::sanitize("a/./b.js").unwrap(),
        std::path::PathBuf::from("a/b.js")
    );
}

#[test]
fn static_resolve_serves_inside_root_and_falls_back_to_index() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("m");
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("index.html"), "<html>").unwrap();
    std::fs::write(root.join("assets/app.js"), "x").unwrap();
    std::fs::write(dir.path().join("secret.txt"), "s").unwrap();
    let real_root = root.canonicalize().unwrap();
    assert_eq!(
        static_files::resolve(&root, "assets/app.js").unwrap(),
        real_root.join("assets/app.js")
    );
    assert_eq!(
        static_files::resolve(&root, "").unwrap(),
        real_root.join("index.html")
    );
    assert_eq!(
        static_files::resolve(&root, "chat/123").unwrap(),
        real_root.join("index.html")
    );
    assert_eq!(
        static_files::resolve(&root, "missing.js"),
        Err(StaticError::NotFound)
    );
    assert_eq!(
        static_files::resolve(&root, "../secret.txt"),
        Err(StaticError::Forbidden)
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("link.txt")).unwrap();
        assert_eq!(
            static_files::resolve(&root, "link.txt"),
            Err(StaticError::Forbidden)
        );
    }
}

#[test]
fn content_types() {
    use std::path::Path;
    assert_eq!(
        static_files::content_type(Path::new("a.JS")),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(
        static_files::content_type(Path::new("a.svg")),
        "image/svg+xml"
    );
    assert_eq!(
        static_files::content_type(Path::new("a")),
        "application/octet-stream"
    );
}

// -- interface / transport ----------------------------------------------------

#[test]
fn tailscale_range() {
    assert!(is_tailscale_ip("100.64.0.1".parse().unwrap()));
    assert!(is_tailscale_ip("100.127.255.254".parse().unwrap()));
    assert!(!is_tailscale_ip("100.128.0.1".parse().unwrap()));
    assert!(!is_tailscale_ip("100.63.0.1".parse().unwrap()));
    assert!(is_private_lan_ip("192.168.1.2".parse().unwrap()));
    assert!(is_private_lan_ip("10.0.0.2".parse().unwrap()));
    assert!(!is_private_lan_ip("8.8.8.8".parse().unwrap()));
    assert!(!is_private_lan_ip("100.64.0.1".parse().unwrap()));
}

#[test]
fn bind_address_selection_never_widens() {
    let ts = Some("100.101.1.2".parse().unwrap());
    let lan = Some("192.168.1.20".parse().unwrap());
    assert_eq!(
        select_bind_ip(Interface::Tailscale, ts, lan),
        Ok("100.101.1.2".parse().unwrap())
    );
    assert_eq!(
        select_bind_ip(Interface::Lan, ts, lan),
        Ok("192.168.1.20".parse().unwrap())
    );
    assert_eq!(
        select_bind_ip(Interface::Localhost, None, None),
        Ok(Ipv4Addr::LOCALHOST)
    );
    assert!(select_bind_ip(Interface::Tailscale, None, lan).is_err());
    assert!(select_bind_ip(Interface::Lan, ts, None).is_err());
    // A detected address outside the interface's range is refused.
    assert!(select_bind_ip(Interface::Tailscale, lan, lan).is_err());
    assert!(select_bind_ip(
        Interface::Lan,
        Some("8.8.8.8".parse().unwrap()),
        Some("8.8.8.8".parse().unwrap())
    )
    .is_err());
    assert!(select_bind_ip(Interface::Lan, None, Some(Ipv4Addr::UNSPECIFIED)).is_err());
}

#[test]
fn transport_plan() {
    assert_eq!(
        plan_tls(Interface::Lan, false, false),
        TlsSource::SelfSigned
    );
    assert_eq!(plan_tls(Interface::Lan, true, false), TlsSource::Custom);
    assert_eq!(
        plan_tls(Interface::Tailscale, false, true),
        TlsSource::Tailscale
    );
    assert_eq!(
        plan_tls(Interface::Tailscale, false, false),
        TlsSource::None
    );
    assert_eq!(
        plan_tls(Interface::Localhost, false, false),
        TlsSource::None
    );
}

#[test]
fn config_defaults_and_validation() {
    let cfg = RemoteConfig::default();
    assert!(!cfg.enabled);
    assert_eq!(cfg.port, DEFAULT_PORT);
    assert!(!cfg.allow_always_allow);
    assert!(cfg.validate().is_ok());
    assert!(RemoteConfig {
        port: 80,
        ..cfg.clone()
    }
    .validate()
    .is_err());
    assert!(RemoteConfig {
        cert_path: Some("a".into()),
        ..cfg.clone()
    }
    .validate()
    .is_err());
}

#[test]
fn self_signed_certificate_is_reused_for_the_same_address() {
    let dir = tempfile::tempdir().unwrap();
    let a = super::tls::self_signed(dir.path(), "192.168.1.20").unwrap();
    let b = super::tls::self_signed(dir.path(), "192.168.1.20").unwrap();
    assert_eq!(a.fingerprint, b.fingerprint);
    assert_eq!(a.fingerprint.split(':').count(), 32);
    let c = super::tls::self_signed(dir.path(), "192.168.1.21").unwrap();
    assert_ne!(a.fingerprint, c.fingerprint);
}

// -- HTTP server --------------------------------------------------------------

async fn serve(hub: Arc<RemoteHub>) -> (server::RunningServer, SocketAddr) {
    let s = server::start(hub, "127.0.0.1:0".parse().unwrap(), None, None)
        .await
        .unwrap();
    let addr = s.addr;
    (s, addr)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn http_requires_a_token_and_the_right_host_and_origin() {
    let (hub, _) = hub();
    let (token, _) = pair(&hub, "Pixel");
    let (srv, addr) = serve(hub.clone()).await;
    let base = format!("http://{addr}/remote/v1");
    let c = client();

    let r = c.get(format!("{base}/me")).send().await.unwrap();
    assert_eq!(r.status(), 401);
    let r = c
        .get(format!("{base}/me"))
        .bearer_auth("wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let r = c
        .get(format!("{base}/me"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["name"], "Pixel");
    assert_eq!(
        c.get(format!("{base}/me"))
            .bearer_auth(&token)
            .header("host", "evil.example:1340")
            .send()
            .await
            .unwrap()
            .status(),
        421
    );
    assert_eq!(
        c.get(format!("{base}/me"))
            .bearer_auth(&token)
            .header("origin", "http://evil.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        c.get(format!("{base}/me"))
            .bearer_auth(&token)
            .header("origin", format!("http://{addr}"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    // The query string is never a credential.
    assert_eq!(
        c.get(format!("{base}/me?token={token}"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    // Placeholder page and traversal.
    let r = c.get(format!("http://{addr}/m/")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/html"));
    assert_eq!(
        c.get(format!("http://{addr}/m/..%2fsecret"))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    // Unpair self.
    assert_eq!(
        c.delete(format!("{base}/me"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        c.get(format!("{base}/me"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    srv.stop();
}

#[tokio::test]
async fn http_pairing_flow() {
    let (hub, rec) = hub();
    let (srv, addr) = serve(hub.clone()).await;
    let base = format!("http://{addr}/remote/v1");
    let c = client();
    let start = hub.start_pairing();
    let r: Value = c
        .post(format!("{base}/pair"))
        .json(&json!({ "code": start.code, "deviceName": "Pixel" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r["confirmNumber"], start.confirm_number);
    let poll = r["pollId"].as_str().unwrap().to_string();
    let status = |poll: String| {
        let c = c.clone();
        let base = base.clone();
        async move {
            c.get(format!("{base}/pair/status"))
                .header("x-flint-pairing", poll)
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    };
    assert_eq!(status(poll.clone()).await["status"], "pending");
    let req = rec.pairings.lock().unwrap()[0].clone();
    hub.confirm_pairing(&req.request_id, true).unwrap();
    let approved = status(poll.clone()).await;
    assert_eq!(approved["status"], "approved");
    let token = approved["token"].as_str().unwrap();
    assert_eq!(
        c.get(format!("{base}/me"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    // Reusing the code fails.
    let again = c
        .post(format!("{base}/pair"))
        .json(&json!({ "code": start.code, "deviceName": "Other" }))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 401);
    srv.stop();
}

#[tokio::test]
async fn websocket_auth_events_and_revocation() {
    let (hub, _) = hub();
    let (token, id) = pair(&hub, "Pixel");
    let (srv, addr) = serve(hub.clone()).await;
    let url = format!("ws://{addr}/remote/v1/events");

    // A bad subprotocol token is refused before the upgrade.
    let mut bad = url.clone().into_client_request().unwrap();
    bad.headers_mut().insert(
        "sec-websocket-protocol",
        "flint-remote.v1, flint-auth.wrong".parse().unwrap(),
    );
    assert!(tokio_tungstenite::connect_async(bad).await.is_err());

    // First-message auth.
    let (mut ws, _) = tokio_tungstenite::connect_async(url.clone()).await.unwrap();
    ws.send(Message::Text(
        json!({ "type": "auth", "token": token }).to_string().into(),
    ))
    .await
    .unwrap();
    let ready: Value = match ws.next().await.unwrap().unwrap() {
        Message::Text(t) => serde_json::from_str(&t).unwrap(),
        m => panic!("{m:?}"),
    };
    assert_eq!(ready["type"], "ready");
    ws.send(Message::Text(
        json!({ "type": "subscribe", "topics": ["t1"] })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    // Let the subscription land before emitting.
    ws.send(Message::Text(json!({ "type": "ping" }).to_string().into()))
        .await
        .unwrap();
    let _pong = ws.next().await;

    hub.emit(OutboundEvent {
        topic: Some("t2".into()),
        event: json!({ "type": "hidden" }),
    });
    hub.emit(OutboundEvent {
        topic: Some("t1".into()),
        event: json!({ "type": "shown" }),
    });
    let ev: Value = match ws.next().await.unwrap().unwrap() {
        Message::Text(t) => serde_json::from_str(&t).unwrap(),
        m => panic!("{m:?}"),
    };
    assert_eq!(ev["event"]["type"], "shown");
    assert!(hub.list_devices()[0].connected);

    // Revoking closes the socket now.
    hub.revoke(&id);
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok());
    srv.stop();
}

#[tokio::test]
async fn websocket_subprotocol_auth() {
    let (hub, _) = hub();
    let (token, _) = pair(&hub, "Pixel");
    let (srv, addr) = serve(hub.clone()).await;
    let mut req = format!("ws://{addr}/remote/v1/events")
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "sec-websocket-protocol",
        format!("flint-remote.v1, flint-auth.{token}")
            .parse()
            .unwrap(),
    );
    let (mut ws, resp) = tokio_tungstenite::connect_async(req).await.unwrap();
    assert_eq!(resp.headers()["sec-websocket-protocol"], "flint-remote.v1");
    let first = ws.next().await.unwrap().unwrap();
    assert!(first.to_text().unwrap().contains("ready"));
    srv.stop();
}

#[test]
fn pairing_url_carries_code_and_name_in_the_fragment() {
    use super::commands::pairing_url;
    assert_eq!(
        pairing_url("https://desk.tailnet.ts.net:1340", "abc123", None),
        "https://desk.tailnet.ts.net:1340/m/#pair=abc123"
    );
    assert_eq!(
        pairing_url("http://100.64.0.2:1340", "abc123", Some("Jo's Desk PC")),
        "http://100.64.0.2:1340/m/#pair=abc123&name=Jo%27s+Desk+PC"
    );
}

#[test]
fn phone_app_dir_prefers_the_bundled_resources_folder() {
    use super::commands::phone_app_dir;
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(phone_app_dir(tmp.path()), tmp.path().join("mobile"));
    let nested = tmp.path().join("resources").join("mobile");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("index.html"), "<!doctype html>").unwrap();
    assert_eq!(phone_app_dir(tmp.path()), nested);
}

#[test]
fn rpc_target_names_what_a_call_acts_on() {
    assert_eq!(rpc_target(&json!({"kind": "chat", "id": "t1", "text": "secret"})).as_deref(), Some("chat:t1"));
    assert_eq!(rpc_target(&json!({"requestId": "r9", "decision": "allow"})).as_deref(), Some("request:r9"));
    assert_eq!(rpc_target(&json!({"all": true})).as_deref(), Some("all"));
    assert_eq!(rpc_target(&json!({"key": "webSearch", "value": true})).as_deref(), Some("setting:webSearch"));
    assert_eq!(rpc_target(&json!({"scope": "cowork", "id": "s1"})).as_deref(), Some("cowork:s1"));
    assert_eq!(rpc_target(&json!({"id": "room1", "text": "hi"})).as_deref(), Some("room1"));
    assert_eq!(rpc_target(&json!({"new": true, "text": "hi"})).as_deref(), Some("new"));
    assert_eq!(rpc_target(&json!({"text": "hi"})), None);
    let long = "x".repeat(200);
    assert_eq!(rpc_target(&json!({"id": long})).map(|t| t.len()), Some(80));
}
