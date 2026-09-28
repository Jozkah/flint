//! The desktop side of remote access: Tauri commands for the Settings page and
//! the frontend bridge, and the events the window receives.
//!
//! Events to the window (main webview only):
//! - `remote://rpc`              a phone's call, answered by `remote_rpc_respond`
//! - `remote://pairing-request`  a phone used the code; show the confirm dialog
//! - `remote://devices-changed`  paired or connected phones changed

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, State};

use super::auth::{DeviceInfo, DeviceStore};
use super::config::{
    detect_lan_ip, detect_tailscale_ip, plan_tls, select_bind_ip, Interface, RemoteConfig,
    TlsSource,
};
use super::hub::{
    Frontend, OutboundEvent, PairingRequestEvent, RemoteHub, RpcError, RpcRequestEvent,
};
use super::server::{self, RunningServer};
use super::tls;
use crate::core::app::commands::get_jan_data_folder_path;

pub const EVENT_RPC: &str = "remote://rpc";
pub const EVENT_PAIRING_REQUEST: &str = "remote://pairing-request";
pub const EVENT_DEVICES_CHANGED: &str = "remote://devices-changed";
const MAIN_WEBVIEW: &str = "main";

struct TauriFrontend<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Frontend for TauriFrontend<R> {
    fn rpc(&self, req: &RpcRequestEvent) -> bool {
        self.0.get_webview_window(MAIN_WEBVIEW).is_some()
            && self
                .0
                .emit_to(EventTarget::webview(MAIN_WEBVIEW), EVENT_RPC, req)
                .is_ok()
    }
    fn pairing_request(&self, req: &PairingRequestEvent) {
        let _ = self.0.emit_to(
            EventTarget::webview(MAIN_WEBVIEW),
            EVENT_PAIRING_REQUEST,
            req,
        );
        // The user has to look at the computer to confirm: bring it forward.
        if let Some(w) = self.0.get_webview_window(MAIN_WEBVIEW) {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
    fn devices_changed(&self) {
        let _ = self.0.emit_to(
            EventTarget::webview(MAIN_WEBVIEW),
            EVENT_DEVICES_CHANGED,
            (),
        );
    }
}

/// Where the listener is and how it is secured, while it runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeInfo {
    pub address: String,
    /// What a phone should connect to: the certificate's DNS name, or the IP.
    pub host: String,
    pub port: u16,
    pub https: bool,
    pub tls_source: TlsSource,
    pub fingerprint: Option<String>,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub tailscale: Option<String>,
    pub lan: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub config: RemoteConfig,
    pub running: bool,
    pub serving: Option<ServeInfo>,
    pub error: Option<String>,
    pub detected: Detected,
    pub paired_devices: usize,
    pub connected_devices: usize,
}

#[derive(Default)]
struct Runtime_ {
    server: Option<RunningServer>,
    serving: Option<ServeInfo>,
    error: Option<String>,
}

pub struct RemoteState {
    pub hub: Arc<RemoteHub>,
    dir: PathBuf,
    rt: tokio::sync::Mutex<Runtime_>,
}

/// Where the phone app (web-app `build:mobile`) sits among the bundled
/// resources. The bundle config lists the folder `resources/mobile/`, which
/// keeps that path under the resource dir; a flat `mobile/` is accepted too.
pub(crate) fn phone_app_dir(resources: &std::path::Path) -> PathBuf {
    let nested = resources.join("resources").join("mobile");
    if nested.join("index.html").is_file() {
        nested
    } else {
        resources.join("mobile")
    }
}

fn remote_dir(data: &std::path::Path) -> PathBuf {
    data.join("remote")
}

/// Sets up remote access at app start and starts the listener if the user
/// left it on.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let dir = remote_dir(&get_jan_data_folder_path(app.clone()));
    let config = RemoteConfig::load(&dir.join("config.json"));
    let devices = DeviceStore::load(dir.join("devices.json"));
    let static_dir = app.path().resource_dir().ok().map(|d| phone_app_dir(&d));
    let hub = Arc::new(RemoteHub::new(
        config.clone(),
        devices,
        Arc::new(TauriFrontend(app.clone())),
        static_dir,
    ));
    app.manage(RemoteState {
        hub,
        dir,
        rt: tokio::sync::Mutex::new(Runtime_::default()),
    });
    if config.enabled {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<RemoteState>();
            apply(&state).await;
        });
    }
}

/// Stops the listener, then starts it again if remote access is on, with the
/// current settings. Errors are kept for the status view.
async fn apply(state: &RemoteState) {
    let mut rt = state.rt.lock().await;
    if let Some(s) = rt.server.take() {
        s.stop();
    }
    rt.serving = None;
    rt.error = None;
    let cfg = state.hub.config();
    if !cfg.enabled {
        return;
    }
    match start(state, &cfg).await {
        Ok((server, info)) => {
            rt.server = Some(server);
            rt.serving = Some(info);
        }
        Err(e) => {
            log::warn!("remote: could not start: {e}");
            rt.error = Some(e);
        }
    }
}

async fn start(
    state: &RemoteState,
    cfg: &RemoteConfig,
) -> Result<(RunningServer, ServeInfo), String> {
    let iface = cfg.interface;
    let (ts, lan) = detect().await;
    let ip = select_bind_ip(iface, ts, lan)?;
    let tls_dir = state.dir.join("tls");
    let custom = cfg.custom_cert();
    let ts_cert = if custom.is_none() && iface == Interface::Tailscale {
        let dir = tls_dir.clone();
        tauri::async_runtime::spawn_blocking(move || tls::tailscale_cert(&dir))
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let source = plan_tls(iface, custom.is_some(), ts_cert.is_some());
    let loaded = match source {
        TlsSource::Custom => {
            let (c, k) = custom.expect("planned from custom");
            Some(tls::load_pem(&c, &k, None)?)
        }
        TlsSource::Tailscale => {
            let (c, k, name) = ts_cert.expect("planned from tailscale cert");
            Some(tls::load_pem(&c, &k, Some(name))?)
        }
        TlsSource::SelfSigned => Some(tls::self_signed(&tls_dir, &ip.to_string())?),
        TlsSource::None => None,
    };
    let hostname = loaded.as_ref().and_then(|l| l.hostname.clone());
    let fingerprint = loaded.as_ref().map(|l| l.fingerprint.clone());
    let addr = SocketAddr::new(IpAddr::V4(ip), cfg.port);
    let server = server::start(
        state.hub.clone(),
        addr,
        loaded.map(|l| l.config),
        hostname.clone(),
    )
    .await
    .map_err(|e| format!("Cannot listen on {addr}: {e}"))?;
    let https = source != TlsSource::None;
    let host = hostname.unwrap_or_else(|| ip.to_string());
    let info = ServeInfo {
        address: ip.to_string(),
        base_url: format!(
            "{}://{host}:{}",
            if https { "https" } else { "http" },
            server.addr.port()
        ),
        host,
        port: server.addr.port(),
        https,
        tls_source: source,
        fingerprint,
    };
    Ok((server, info))
}

async fn detect() -> (Option<std::net::Ipv4Addr>, Option<std::net::Ipv4Addr>) {
    tauri::async_runtime::spawn_blocking(|| (detect_tailscale_ip(), detect_lan_ip()))
        .await
        .unwrap_or((None, None))
}

async fn status_of(state: &RemoteState) -> RemoteStatus {
    let (ts, lan) = detect().await;
    let rt = state.rt.lock().await;
    RemoteStatus {
        config: state.hub.config(),
        running: rt.server.is_some(),
        serving: rt.serving.clone(),
        error: rt.error.clone(),
        detected: Detected {
            tailscale: ts.map(|i| i.to_string()),
            lan: lan.map(|i| i.to_string()),
        },
        paired_devices: state.hub.list_devices().len(),
        connected_devices: state.hub.connected_count(),
    }
}

#[tauri::command]
pub async fn remote_get_status(state: State<'_, RemoteState>) -> Result<RemoteStatus, String> {
    Ok(status_of(&state).await)
}

#[tauri::command]
pub async fn remote_set_config(
    state: State<'_, RemoteState>,
    config: RemoteConfig,
) -> Result<RemoteStatus, String> {
    config.validate()?;
    config
        .save(&state.dir.join("config.json"))
        .map_err(|e| format!("Could not save settings: {e}"))?;
    let previous = state.hub.config();
    state.hub.set_config(config.clone());
    log::info!(
        "remote: settings changed (enabled={}, interface={:?}, port={}, approvals={}, always_allow={})",
        config.enabled,
        config.interface,
        config.port,
        config.allow_approvals,
        config.allow_always_allow
    );
    // The permission switches take effect on the next call; only listener
    // settings need a restart.
    let listener_changed = previous.enabled != config.enabled
        || previous.interface != config.interface
        || previous.port != config.port
        || previous.cert_path != config.cert_path
        || previous.key_path != config.key_path;
    let not_running = state.rt.lock().await.server.is_none();
    if listener_changed || (config.enabled && not_running) {
        apply(&state).await;
    }
    Ok(status_of(&state).await)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub code: String,
    pub confirm_number: String,
    pub expires_in_ms: u64,
    /// For the QR code. The code rides in the fragment, which browsers never
    /// send to a server or put in a Referer.
    pub url: String,
}

/// This computer's name, for the phone's "Pair with <computer>?".
fn computer_name() -> Option<String> {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .map(|h| h.split('.').next().unwrap_or_default().trim().to_string())
        .filter(|h| !h.is_empty())
}

/// The link the QR code carries. The code (and the computer's name, shown
/// before pairing) ride in the fragment, which browsers never send to a
/// server or put in a Referer.
pub fn pairing_url(base: &str, code: &str, name: Option<&str>) -> String {
    let mut url = format!("{base}/m/#pair={code}");
    if let Some(name) = name {
        url.push_str("&name=");
        url.extend(url::form_urlencoded::byte_serialize(name.as_bytes()));
    }
    url
}

#[tauri::command]
pub async fn remote_start_pairing(state: State<'_, RemoteState>) -> Result<PairingInfo, String> {
    let base = state
        .rt
        .lock()
        .await
        .serving
        .as_ref()
        .map(|s| s.base_url.clone())
        .ok_or("Turn on remote access first")?;
    let p = state.hub.start_pairing();
    Ok(PairingInfo {
        url: pairing_url(&base, &p.code, computer_name().as_deref()),
        code: p.code,
        confirm_number: p.confirm_number,
        expires_in_ms: p.expires_in_ms,
    })
}

#[tauri::command]
pub fn remote_cancel_pairing(state: State<'_, RemoteState>) {
    state.hub.cancel_pairing();
}

#[tauri::command]
pub fn remote_confirm_pairing(
    state: State<'_, RemoteState>,
    request_id: String,
    approve: bool,
) -> Result<Option<DeviceInfo>, String> {
    state
        .hub
        .confirm_pairing(&request_id, approve)
        .map_err(|_| "This pairing request has expired".to_string())
}

#[tauri::command]
pub fn remote_list_devices(state: State<'_, RemoteState>) -> Vec<DeviceInfo> {
    state.hub.list_devices()
}

#[tauri::command]
pub fn remote_revoke_device(state: State<'_, RemoteState>, id: String) -> bool {
    state.hub.revoke(&id)
}

#[derive(Debug, Deserialize)]
pub struct RpcErrorArg {
    pub code: String,
    pub message: String,
}

/// The window's answer to `remote://rpc`. Exactly one of `result`/`error`.
#[tauri::command]
pub fn remote_rpc_respond(
    state: State<'_, RemoteState>,
    id: String,
    result: Option<Value>,
    error: Option<RpcErrorArg>,
) -> bool {
    let outcome = match error {
        Some(e) => Err(RpcError::new(&e.code, e.message)),
        None => Ok(result.unwrap_or(Value::Null)),
    };
    state.hub.respond(&id, outcome)
}

/// Pushes an event to connected phones; `topic` limits it to subscribers.
#[tauri::command]
pub fn remote_emit_event(state: State<'_, RemoteState>, event: Value, topic: Option<String>) {
    state.hub.emit(OutboundEvent { topic, event });
}
