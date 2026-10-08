//! The state every connection shares: paired devices, the pairing in
//! progress, rate limits, RPCs waiting on the desktop window, and the event
//! fan-out to connected phones. Tauri-free: the window is reached through
//! [`Frontend`], which the app implements with Tauri events and tests with a
//! recorder.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

use super::auth::{
    now_ms, Device, DeviceInfo, DeviceStore, PairError, PairingBook, PairingClaim, PairingStart,
    PollResult, RateLimiter,
};
use super::config::RemoteConfig;
use super::preview::{PreviewTarget, TicketBook};
use super::uploads::{Upload, UploadBook, UploadError, UploadInfo};
use super::push::{self, Category, PushNotice, PushPrefs, Subscription, VapidKey};

/// How long a phone's RPC waits for the desktop window to answer.
pub const RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// Transcribing a long recording (and loading the voice model first) takes longer.
pub const VOICE_RPC_TIMEOUT: Duration = Duration::from_secs(150);
/// Pairing attempts per IP per window.
pub const PAIR_LIMIT: usize = 10;
/// Failed authentications per IP per window before the IP is refused
/// outright.
pub const AUTH_FAIL_LIMIT: usize = 20;
pub const LIMIT_WINDOW: Duration = Duration::from_secs(5 * 60);

/// Sent to the window as `remote://rpc`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequestEvent {
    /// The server's id for this call, which `remote_rpc_respond` answers.
    pub id: String,
    pub method: String,
    pub params: Value,
    pub device: DeviceRef,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRef {
    pub id: String,
    pub name: String,
}

/// Sent to the window as `remote://pairing-request`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequestEvent {
    pub request_id: String,
    pub device_name: String,
    pub confirm_number: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

pub type RpcOutcome = Result<Value, RpcError>;

/// An event for connected phones. `topic: None` goes to every socket; a
/// topic goes only to sockets that subscribed to it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OutboundEvent {
    #[serde(default)]
    pub topic: Option<String>,
    pub event: Value,
}

/// How the hub reaches the desktop window.
pub trait Frontend: Send + Sync {
    /// Returns false when no window can take it (the call then fails fast).
    fn rpc(&self, req: &RpcRequestEvent) -> bool;
    fn pairing_request(&self, req: &PairingRequestEvent);
    fn devices_changed(&self);
}

/// Why a phone's RPC was refused before reaching the window.
#[derive(Debug, Clone, PartialEq)]
pub enum RpcReject {
    BadMethod,
    Forbidden(&'static str),
    Unavailable,
    Timeout,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// `ns.name` style: lowercase start, then letters, digits, `.` and `_`.
pub fn valid_method(method: &str) -> bool {
    let mut chars = method.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && method.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

/// Server-side gate on approval methods, independent of what the window
/// would do: a phone can never answer approvals the user turned off, nor
/// grant "Always allow" unless that is on too.
///
/// Any `approvals.*` method that carries `scope: "always"` (or a method whose
/// name says always) is a standing grant.
pub fn check_policy(method: &str, params: &Value, cfg: &RemoteConfig) -> Result<(), &'static str> {
    if !method.starts_with("approvals.") {
        return Ok(());
    }
    if !cfg.allow_approvals {
        return Err("Approvals from phones are turned off on the computer");
    }
    let scope_always = params
        .get("scope")
        .and_then(Value::as_str)
        .is_some_and(|s| s.eq_ignore_ascii_case("always"));
    let named_always = method.to_ascii_lowercase().contains("always");
    if (scope_always || named_always) && !cfg.allow_always_allow {
        return Err("\"Always allow\" from phones is turned off on the computer");
    }
    Ok(())
}

/// What a call acts on, for the log: the conversation, request or setting it
/// names (`chat:abc`, `request:r1`, `setting:webSearch`). Never message text.
pub fn rpc_target(params: &Value) -> Option<String> {
    let s = |k: &str| {
        params
            .get(k)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(80).collect::<String>())
    };
    if let Some(r) = s("requestId") {
        return Some(format!("request:{r}"));
    }
    if params.get("all").and_then(Value::as_bool) == Some(true) {
        return Some("all".into());
    }
    if let Some(key) = s("key") {
        return Some(format!("setting:{key}"));
    }
    let kind = s("kind").or_else(|| s("scope"));
    match (kind, s("id")) {
        (Some(k), Some(id)) => Some(format!("{k}:{id}")),
        (None, Some(id)) => Some(id),
        (Some(k), None) => Some(k),
        (None, None) if params.get("new").and_then(Value::as_bool) == Some(true) => {
            Some("new".into())
        }
        _ => None,
    }
}

pub struct RemoteHub {
    config: Mutex<RemoteConfig>,
    devices: Mutex<DeviceStore>,
    pairing: Mutex<PairingBook>,
    pair_limiter: Mutex<RateLimiter>,
    fail_limiter: Mutex<RateLimiter>,
    pending: Mutex<HashMap<String, oneshot::Sender<RpcOutcome>>>,
    connected: Mutex<HashMap<String, usize>>,
    /// Sockets whose page is showing, per device: those devices get no push.
    visible: Mutex<HashMap<String, usize>>,
    vapid: Mutex<Option<Arc<VapidKey>>>,
    http: reqwest::Client,
    /// For the live preview: loopback only, so never through a proxy.
    local_http: reqwest::Client,
    uploads: Mutex<UploadBook>,
    upload_dir: Mutex<Option<PathBuf>>,
    preview: Mutex<Option<PreviewTarget>>,
    tickets: Mutex<TicketBook>,
    events: broadcast::Sender<OutboundEvent>,
    revoked: broadcast::Sender<String>,
    frontend: Arc<dyn Frontend>,
    pub static_dir: Option<PathBuf>,
    /// Other folders the phone app may sit in, tried after `static_dir`.
    static_dirs: Vec<PathBuf>,
}

impl RemoteHub {
    pub fn new(
        config: RemoteConfig,
        devices: DeviceStore,
        frontend: Arc<dyn Frontend>,
        static_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            config: Mutex::new(config),
            devices: Mutex::new(devices),
            pairing: Mutex::new(PairingBook::default()),
            pair_limiter: Mutex::new(RateLimiter::new(PAIR_LIMIT, LIMIT_WINDOW)),
            fail_limiter: Mutex::new(RateLimiter::new(AUTH_FAIL_LIMIT, LIMIT_WINDOW)),
            pending: Mutex::new(HashMap::new()),
            connected: Mutex::new(HashMap::new()),
            visible: Mutex::new(HashMap::new()),
            vapid: Mutex::new(None),
            http: reqwest::Client::new(),
            local_http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            uploads: Mutex::new(UploadBook::default()),
            upload_dir: Mutex::new(None),
            preview: Mutex::new(None),
            tickets: Mutex::new(TicketBook::default()),
            events: broadcast::channel(256).0,
            revoked: broadcast::channel(16).0,
            frontend,
            static_dir,
            static_dirs: Vec::new(),
        }
    }

    /// Every folder the phone app may sit in, in order of preference.
    pub fn with_static_dirs(mut self, dirs: Vec<PathBuf>) -> Self {
        self.static_dirs = dirs;
        self
    }

    /// The folder holding the phone app right now, if any.
    ///
    /// Looked up on every request, not decided once at start: an update
    /// replaces these files while the app is closing or starting, and a
    /// folder that was empty for that moment must not stay "missing" until
    /// the next restart.
    pub fn phone_app_root(&self) -> Option<&PathBuf> {
        self.static_dir
            .iter()
            .chain(self.static_dirs.iter())
            .find(|d| d.join("index.html").is_file())
    }

    /// Where the phone app was looked for, for the log and the status view.
    pub fn phone_app_candidates(&self) -> Vec<PathBuf> {
        self.static_dir
            .iter()
            .chain(self.static_dirs.iter())
            .cloned()
            .collect()
    }

    pub fn config(&self) -> RemoteConfig {
        lock(&self.config).clone()
    }

    pub fn set_config(&self, cfg: RemoteConfig) {
        *lock(&self.config) = cfg;
    }

    // -- rate limits ---------------------------------------------------------

    /// Whether `ip` has failed authentication too often to be served.
    pub fn is_blocked(&self, ip: IpAddr) -> bool {
        lock(&self.fail_limiter).is_blocked(ip, Instant::now())
    }

    pub fn note_failure(&self, ip: IpAddr) {
        lock(&self.fail_limiter).hit(ip, Instant::now());
    }

    // -- devices -------------------------------------------------------------

    /// The device a bearer token belongs to. A miss counts against `ip`.
    pub fn authenticate(&self, token: Option<&str>, ip: IpAddr) -> Option<Device> {
        let device = token.and_then(|t| lock(&self.devices).verify(t));
        match &device {
            Some(d) => lock(&self.devices).touch(&d.id, now_ms()),
            None => self.note_failure(ip),
        }
        device
    }

    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        let connected = lock(&self.connected);
        lock(&self.devices)
            .list()
            .iter()
            .map(|d| DeviceInfo {
                id: d.id.clone(),
                name: d.name.clone(),
                paired_at: d.paired_at,
                last_seen: d.last_seen,
                connected: connected.get(&d.id).copied().unwrap_or(0) > 0,
            })
            .collect()
    }

    /// Unpairs a device and closes its sockets now.
    pub fn revoke(&self, id: &str) -> bool {
        let removed = lock(&self.devices).revoke(id);
        if let Some(d) = &removed {
            log::info!("remote: phone '{}' was unpaired", d.name);
            let _ = self.revoked.send(d.id.clone());
            lock(&self.tickets).revoke_device(&d.id);
            self.frontend.devices_changed();
        }
        removed.is_some()
    }

    pub fn subscribe_revocations(&self) -> broadcast::Receiver<String> {
        self.revoked.subscribe()
    }

    pub fn socket_opened(&self, device_id: &str) {
        *lock(&self.connected)
            .entry(device_id.to_string())
            .or_default() += 1;
        self.frontend.devices_changed();
    }

    pub fn socket_closed(&self, device_id: &str) {
        let mut c = lock(&self.connected);
        if let Some(n) = c.get_mut(device_id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                c.remove(device_id);
            }
        }
        drop(c);
        self.frontend.devices_changed();
    }

    /// A socket's page became visible (`true`) or hidden.
    pub fn socket_visible(&self, device_id: &str, visible: bool) {
        let mut v = lock(&self.visible);
        let n = v.entry(device_id.to_string()).or_default();
        if visible {
            *n += 1;
        } else {
            *n = n.saturating_sub(1);
            if *n == 0 {
                v.remove(device_id);
            }
        }
    }

    /// Whether some page of this device is open and showing.
    pub fn is_visible(&self, device_id: &str) -> bool {
        lock(&self.visible).get(device_id).copied().unwrap_or(0) > 0
    }

    pub fn connected_count(&self) -> usize {
        lock(&self.connected).len()
    }

    // -- pairing -------------------------------------------------------------

    pub fn start_pairing(&self) -> PairingStart {
        lock(&self.pairing).start(Instant::now())
    }

    pub fn cancel_pairing(&self) {
        lock(&self.pairing).cancel();
    }

    /// A phone presents a code. Rate-limited per IP; a wrong code also counts
    /// as a failed authentication.
    pub fn claim_pairing(
        &self,
        ip: IpAddr,
        code: &str,
        device_name: &str,
    ) -> Result<PairingClaim, ClaimError> {
        if !lock(&self.pair_limiter).hit(ip, Instant::now()) {
            return Err(ClaimError::RateLimited);
        }
        let claim = lock(&self.pairing)
            .claim(code, device_name, Instant::now())
            .map_err(|_| {
                self.note_failure(ip);
                ClaimError::InvalidCode
            })?;
        log::info!(
            "remote: phone '{}' asked to pair from {ip}",
            claim.device_name
        );
        self.frontend.pairing_request(&PairingRequestEvent {
            request_id: claim.request_id.clone(),
            device_name: claim.device_name.clone(),
            confirm_number: claim.confirm_number.clone(),
        });
        Ok(claim)
    }

    pub fn confirm_pairing(
        &self,
        request_id: &str,
        approve: bool,
    ) -> Result<Option<DeviceInfo>, PairError> {
        let devices = &self.devices;
        let result = lock(&self.pairing).confirm(request_id, approve, Instant::now(), |name| {
            lock(devices).add(name)
        })?;
        let info = result.map(|d| {
            log::info!("remote: phone '{}' paired", d.name);
            DeviceInfo {
                id: d.id,
                name: d.name,
                paired_at: d.paired_at,
                last_seen: d.last_seen,
                connected: false,
            }
        });
        if info.is_some() {
            self.frontend.devices_changed();
        }
        Ok(info)
    }

    pub fn poll_pairing(&self, ip: IpAddr, poll_id: &str) -> PollResult {
        let r = lock(&self.pairing).poll(poll_id, Instant::now());
        if r == PollResult::Expired {
            self.note_failure(ip);
        }
        r
    }

    pub fn pairing_waiting(&self) -> bool {
        lock(&self.pairing).is_waiting(Instant::now())
    }

    // -- rpc -----------------------------------------------------------------

    /// Forwards a phone's call to the window and waits for its answer.
    pub async fn rpc(
        &self,
        device: &Device,
        method: &str,
        params: Value,
    ) -> Result<RpcOutcome, RpcReject> {
        let timeout = if method == "voice.transcribe" { VOICE_RPC_TIMEOUT } else { RPC_TIMEOUT };
        self.rpc_with_timeout(device, method, params, timeout)
            .await
    }

    pub async fn rpc_with_timeout(
        &self,
        device: &Device,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<RpcOutcome, RpcReject> {
        if !valid_method(method) {
            return Err(RpcReject::BadMethod);
        }
        if let Err(why) = check_policy(method, &params, &self.config()) {
            log::warn!(
                "remote: phone '{}' was refused {method}: {why}",
                device.name
            );
            return Err(RpcReject::Forbidden(why));
        }
        match rpc_target(&params) {
            Some(target) => log::info!(
                "remote: phone '{}' called {method} on {target}",
                device.name
            ),
            None => log::info!("remote: phone '{}' called {method}", device.name),
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), tx);
        let req = RpcRequestEvent {
            id: id.clone(),
            method: method.to_string(),
            params,
            device: DeviceRef {
                id: device.id.clone(),
                name: device.name.clone(),
            },
        };
        if !self.frontend.rpc(&req) {
            lock(&self.pending).remove(&id);
            return Err(RpcReject::Unavailable);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(_)) => Err(RpcReject::Unavailable),
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(RpcReject::Timeout)
            }
        }
    }

    /// The window's answer to an RPC. False when nothing waits under `id`
    /// (it timed out, or was never asked).
    pub fn respond(&self, id: &str, outcome: RpcOutcome) -> bool {
        match lock(&self.pending).remove(id) {
            Some(tx) => tx.send(outcome).is_ok(),
            None => false,
        }
    }

    // -- events --------------------------------------------------------------

    pub fn emit(&self, event: OutboundEvent) {
        // No receivers is not an error: no phone is connected.
        let _ = self.events.send(event);
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<OutboundEvent> {
        self.events.subscribe()
    }
}

/// A push to send: which device, where, and the plaintext payload.
#[derive(Debug, Clone, PartialEq)]
pub struct PushTarget {
    pub device_id: String,
    pub subscription: Subscription,
    pub payload: Value,
    pub category: Category,
}

impl RemoteHub {
    // -- uploads -------------------------------------------------------------

    pub fn set_upload_dir(&self, dir: PathBuf) {
        // Whatever an earlier run left here belongs to no upload any more.
        lock(&self.uploads).sweep(&dir);
        *lock(&self.upload_dir) = Some(dir);
    }

    pub fn upload_start(&self, device_id: &str, name: &str, size: u64, mime: &str) -> Result<Upload, UploadError> {
        let root = lock(&self.upload_dir).clone().ok_or(UploadError::Io("uploads are not set up".into()))?;
        let max = self.config().max_upload_mb;
        lock(&self.uploads).start(&root, device_id, name, size, mime, max, Instant::now())
    }

    pub fn upload_check(&self, device_id: &str, id: &str, offset: u64, len: usize) -> Result<Upload, UploadError> {
        lock(&self.uploads).reserve_chunk(device_id, id, offset, len)
    }

    pub fn upload_release(&self, id: &str) {
        lock(&self.uploads).release_chunk(id)
    }

    pub fn upload_wrote(&self, id: &str, len: usize) -> u64 {
        lock(&self.uploads).wrote(id, len, Instant::now())
    }

    pub fn upload_get(&self, device_id: &str, id: &str) -> Option<Upload> {
        lock(&self.uploads).get(device_id, id).cloned()
    }

    pub fn upload_finish(&self, device_id: &str, id: &str, head: &[u8]) -> Result<UploadInfo, UploadError> {
        lock(&self.uploads).finish(device_id, id, head)
    }

    pub fn upload_remove(&self, device_id: &str, id: &str) -> bool {
        lock(&self.uploads).remove(device_id, id)
    }

    /// Finished uploads of a device, for the window to attach.
    pub fn uploads_finished(&self, device_id: &str, ids: &[String]) -> Vec<Upload> {
        lock(&self.uploads).finished(device_id, ids)
    }

    // -- preview -------------------------------------------------------------

    /// The window's live preview for a session (`None` clears it).
    pub fn set_preview(&self, target: Option<PreviewTarget>) {
        *lock(&self.preview) = target;
    }

    pub fn preview(&self) -> Option<PreviewTarget> {
        lock(&self.preview).clone()
    }

    /// A ticket for `device` to view `session_id`'s live preview, with the
    /// path to load. `None` when that session has no live preview, or the
    /// setting is off.
    pub fn preview_ticket(&self, device_id: &str, session_id: &str) -> Option<(String, String)> {
        if !self.config().allow_preview_proxy {
            return None;
        }
        let target = self.preview().filter(|t| t.session_id == session_id)?;
        let ticket = lock(&self.tickets).issue(device_id, session_id, Instant::now());
        Some((ticket, target.start))
    }

    /// The origin a ticket may reach: its device still paired, its session's
    /// preview still the registered one.
    pub fn preview_origin_for(&self, ticket: &str) -> Option<String> {
        if !self.config().allow_preview_proxy {
            return None;
        }
        let (device, session) = lock(&self.tickets).check(ticket, Instant::now())?;
        lock(&self.devices).get(&device)?;
        self.preview()
            .filter(|t| t.session_id == session)
            .map(|t| t.origin)
    }

    /// The client for the live preview (loopback, no proxy, no redirects).
    pub fn http(&self) -> &reqwest::Client {
        &self.local_http
    }

    // -- push ----------------------------------------------------------------

    pub fn set_vapid(&self, key: VapidKey) {
        *lock(&self.vapid) = Some(Arc::new(key));
    }

    pub fn vapid_public_key(&self) -> Option<String> {
        lock(&self.vapid).as_ref().map(|k| k.public_key_b64())
    }

    pub fn push_state(&self, device_id: &str) -> Option<push::DevicePush> {
        lock(&self.devices).get(device_id).map(|d| d.push.clone())
    }

    pub fn set_subscription(&self, device_id: &str, sub: Option<Subscription>) -> bool {
        lock(&self.devices).update_push(device_id, |p| p.subscription = sub)
    }

    pub fn set_push_prefs(&self, device_id: &str, prefs: PushPrefs) -> bool {
        lock(&self.devices).update_push(device_id, |p| p.prefs = prefs)
    }

    /// Who gets `notice` now: subscribed devices whose switches allow it
    /// and that have no page showing. `only` limits it to one device (tests
    /// from Settings, which go through even while the page is open).
    pub fn push_targets(&self, notice: &PushNotice, now_ms: u64, only: Option<&str>) -> Vec<PushTarget> {
        let devices = lock(&self.devices);
        devices
            .list()
            .iter()
            .filter(|d| only.map_or(true, |o| o == d.id))
            .filter_map(|d| {
                let sub = d.push.subscription.clone()?;
                if only.is_none() && self.is_visible(&d.id) {
                    return None;
                }
                if !push::allowed(&d.push.prefs, notice.category, now_ms) {
                    return None;
                }
                Some(PushTarget {
                    device_id: d.id.clone(),
                    subscription: sub,
                    payload: push::payload(notice, &d.push.prefs),
                    category: notice.category,
                })
            })
            .collect()
    }

    /// Sends to each target; drops subscriptions the service says are gone.
    pub async fn deliver(&self, targets: Vec<PushTarget>) -> Vec<(String, push::SendOutcome)> {
        let Some(vapid) = lock(&self.vapid).clone() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for t in targets {
            let outcome = match push::build_request(&vapid, &t.subscription, &t.payload, t.category, now_ms()) {
                Ok(req) => push::send(&self.http, req).await,
                Err(e) => push::SendOutcome::Failed(e),
            };
            match &outcome {
                push::SendOutcome::Gone => {
                    log::info!("remote: push subscription for a phone expired; dropped");
                    lock(&self.devices).update_push(&t.device_id, |p| {
                        if p.subscription.as_ref() == Some(&t.subscription) {
                            p.subscription = None;
                        }
                    });
                }
                push::SendOutcome::Failed(e) => log::warn!("remote: push failed: {e}"),
                push::SendOutcome::Delivered => {}
            }
            out.push((t.device_id, outcome));
        }
        out
    }

    /// `push.*` RPCs, answered here rather than by the window. `None` for
    /// other methods. `push.test` returns its targets for the caller to send.
    pub fn push_rpc(&self, device: &Device, method: &str, params: &Value) -> Option<(RpcOutcome, Vec<PushTarget>)> {
        let bad = |m: &str| Err(RpcError::new("bad_params", m));
        let state = || self.push_state(&device.id).unwrap_or_default();
        let r: RpcOutcome = match method {
            "preview.ticket" => {
                let session = params.get("id").and_then(Value::as_str).unwrap_or("");
                match self.preview_ticket(&device.id, session) {
                    Some((ticket, start)) => Ok(serde_json::json!({
                        "path": format!("{}{}{ticket}{start}", super::server::API_PREFIX, super::preview::PREVIEW_PREFIX),
                    })),
                    None => Err(RpcError::new("not_found", "This session has no live preview on the computer")),
                }
            }
            "push.vapidKey" => match self.vapid_public_key() {
                Some(k) => Ok(serde_json::json!({ "key": k })),
                None => Err(RpcError::new("unavailable", "Push is not set up on the computer")),
            },
            "push.subscribe" => {
                match params.get("subscription").cloned().map(serde_json::from_value::<Subscription>) {
                    Some(Ok(sub)) => match push::validate_subscription(&sub) {
                        Ok(()) => {
                            self.set_subscription(&device.id, Some(sub));
                            if let Some(p) = params.get("prefs").cloned().and_then(|p| serde_json::from_value(p).ok()) {
                                self.set_push_prefs(&device.id, p);
                            }
                            Ok(serde_json::json!({ "ok": true }))
                        }
                        Err(why) => bad(why),
                    },
                    _ => bad("subscription is required"),
                }
            }
            "push.unsubscribe" => {
                self.set_subscription(&device.id, None);
                Ok(serde_json::json!({ "ok": true }))
            }
            "push.get" => {
                let s = state();
                Ok(serde_json::json!({
                    "subscribed": s.subscription.is_some(),
                    "available": self.vapid_public_key().is_some(),
                    "prefs": s.prefs,
                }))
            }
            "push.prefs" => match params.get("prefs").cloned().map(serde_json::from_value::<PushPrefs>) {
                Some(Ok(p)) => {
                    self.set_push_prefs(&device.id, p.clone());
                    Ok(serde_json::json!({ "prefs": p }))
                }
                _ => bad("prefs are required"),
            },
            "push.test" => {
                if state().subscription.is_none() {
                    Err(RpcError::new("not_subscribed", "Turn on notifications on this phone first"))
                } else {
                    let notice = PushNotice {
                        category: Category::Test,
                        title: "Flint".into(),
                        body: "Notifications from this computer work.".into(),
                        url: "/m/".into(),
                        tag: "flint-test".into(),
                        request_id: None,
                    };
                    let t = self.push_targets(&notice, now_ms(), Some(&device.id));
                    return Some((Ok(serde_json::json!({ "sent": t.len() })), t));
                }
            }
            _ => return None,
        };
        Some((r, Vec::new()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimError {
    RateLimited,
    InvalidCode,
}

/// Whether a socket subscribed to `topics` receives `event`.
pub fn event_matches(event: &OutboundEvent, topics: &HashSet<String>) -> bool {
    match &event.topic {
        None => true,
        Some(t) => topics.contains(t),
    }
}
