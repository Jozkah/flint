use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime, State};

use crate::device::{get_devices_from_backend, DeviceInfo};
use crate::error::{ErrorCode, LlamacppError, ServerError, ServerResult};
use crate::state::{LlamacppState, SessionInfo};

type HmacSha256 = Hmac<Sha256>;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct UnloadResult {
    success: bool,
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct ModelRequestBody<'a> {
    model: &'a str,
}

async fn router_endpoint<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> Result<(u16, String, u32), String> {
    let state: State<Arc<LlamacppState>> = app_handle.state();
    let guard = state.router.lock().await;
    let h = guard.as_ref().ok_or_else(|| "router not started".to_string())?;
    Ok((h.port, h.api_key.clone(), h.pid))
}

async fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Payload for the `llamacpp-model-load-progress` event, mirrored from the
/// router's `/models/sse` `status_change` events (`progress.value` is 0.0-1.0).
#[derive(serde::Serialize, Clone)]
pub struct LoadProgressPayload {
    pub model: String,
    pub stage: Option<String>,
    pub value: f64,
}

/// Parses one SSE "event block" (text up to and including a `\n\n`
/// separator) and returns a progress payload if it's a `status_change` event
/// for `model_id` carrying a non-null `progress` field. Returns `None` for
/// any other event, a different model, or malformed input - callers should
/// simply skip the block.
fn parse_load_progress_event(block: &str, model_id: &str) -> Option<LoadProgressPayload> {
    for line in block.lines() {
        let data = line
            .strip_prefix("data: ")
            .or_else(|| line.strip_prefix("data:"))?;
        let json: serde_json::Value = serde_json::from_str(data).ok()?;
        if json.get("model").and_then(|v| v.as_str()) != Some(model_id) {
            continue;
        }
        if json.get("event").and_then(|v| v.as_str()) != Some("status_change") {
            continue;
        }
        let progress = json.get("data").and_then(|d| d.get("progress"))?;
        if progress.is_null() {
            continue;
        }
        let value = progress.get("value").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let stage = progress
            .get("current")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        return Some(LoadProgressPayload {
            model: model_id.to_string(),
            stage,
            value,
        });
    }
    None
}

/// Subscribes to the router's `/models/sse` feed and re-emits `progress`
/// updates for `model_id` as Tauri events, until the connection drops or the
/// task is aborted by the caller once loading finishes.
///
/// `/models/sse` was introduced upstream in build b9747 (server: real-time
/// model load progress tracking, #24828); this plugin doesn't track backend
/// build numbers, so rather than gating ahead of time we just check the
/// response here. Older backends 404 (or otherwise fail) and we return
/// immediately without emitting anything - the UI already has a workaround,
/// falling back to its plain "Loading model..." spinner (`loadingModel`,
/// entirely unaffected by this listener) in `PromptProgress.tsx`.
fn spawn_load_progress_listener<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    port: u16,
    api_key: String,
    model_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use futures_util::StreamExt;

        let client = http_client().await;
        let url = format!("http://127.0.0.1:{}/models/sse", port);
        let resp = match client.get(&url).bearer_auth(&api_key).send().await {
            Ok(r) => r,
            Err(e) => {
                log::debug!("model load progress: failed to connect to /models/sse: {}", e);
                return;
            }
        };
        if !resp.status().is_success() {
            log::debug!(
                "model load progress unavailable on this backend (/models/sse returned {}); \
                 falling back to the plain loading indicator",
                resp.status()
            );
            return;
        }

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            let Ok(bytes) = chunk else { break };
            buf.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(pos) = buf.find("\n\n") {
                let event_block: String = buf.drain(..pos + 2).collect();
                if let Some(payload) = parse_load_progress_event(&event_block, &model_id) {
                    let _ = app_handle.emit("llamacpp-model-load-progress", payload);
                }
            }
        }
    })
}

async fn post_load<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
    port: u16,
    api_key: &str,
    model_id: &str,
) -> ServerResult<()> {
    let client = http_client().await;
    let url = format!("http://127.0.0.1:{}/models/load", port);
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&ModelRequestBody { model: model_id })
        .send()
        .await
        .map_err(|e| {
            ServerError::Llamacpp(LlamacppError::new(
                ErrorCode::InternalError,
                "Failed to call router /models/load".into(),
                Some(e.to_string()),
            ))
        })?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        if !body.to_lowercase().contains("already") {
            return Err(ServerError::Llamacpp(LlamacppError::new(
                ErrorCode::InternalError,
                format!("Router rejected model load (status {})", status),
                Some(body),
            )));
        }
    }

    let progress_task = spawn_load_progress_listener(
        app_handle.clone(),
        port,
        api_key.to_string(),
        model_id.to_string(),
    );

    // /models/load returns success once loading is *initiated*; poll /models
    // until the entry transitions from "loading" to "loaded" (or fails).
    let result = wait_until_loaded(port, api_key, model_id, Duration::from_secs(600)).await;
    progress_task.abort();
    result
}

async fn wait_until_loaded(
    port: u16,
    api_key: &str,
    model_id: &str,
    timeout: Duration,
) -> ServerResult<()> {
    let client = http_client().await;
    let url = format!("http://127.0.0.1:{}/models", port);
    let start = std::time::Instant::now();
    let poll_interval = Duration::from_millis(250);

    loop {
        let resp = client
            .get(&url)
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| {
                ServerError::Llamacpp(LlamacppError::new(
                    ErrorCode::InternalError,
                    "Failed to poll router /models".into(),
                    Some(e.to_string()),
                ))
            })?;

        let json: serde_json::Value = resp.json().await.map_err(|e| {
            ServerError::Llamacpp(LlamacppError::new(
                ErrorCode::InternalError,
                "Invalid JSON from /models".into(),
                Some(e.to_string()),
            ))
        })?;

        let entry = json
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(model_id))
            });

        if let Some(entry) = entry {
            let status = entry.get("status");
            let value = status
                .and_then(|s| s.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match value {
                "loaded" => return Ok(()),
                "loading" => {}
                "unloaded" | "sleeping" => {
                    let failed = status
                        .and_then(|s| s.get("failed"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if failed {
                        let exit_code = status
                            .and_then(|s| s.get("exit_code"))
                            .and_then(|v| v.as_i64());
                        return Err(ServerError::Llamacpp(LlamacppError::new(
                            ErrorCode::InternalError,
                            format!("Model {} failed to load", model_id),
                            Some(format!("exit_code={:?}", exit_code)),
                        )));
                    }
                }
                other => {
                    log::warn!("Unknown model status value: {}", other);
                }
            }
        }

        if start.elapsed() >= timeout {
            return Err(ServerError::Llamacpp(LlamacppError::new(
                ErrorCode::ModelLoadTimedOut,
                format!("Timed out waiting for model {} to load", model_id),
                Some(format!("waited {:?}", timeout)),
            )));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

async fn post_unload(port: u16, api_key: &str, model_id: &str) -> Result<(), String> {
    let client = http_client().await;
    let url = format!("http://127.0.0.1:{}/models/unload", port);
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&ModelRequestBody { model: model_id })
        .send()
        .await
        .map_err(|e| format!("Failed to call /models/unload: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Router rejected unload (status {}): {}", status, body));
    }

    // /models/unload returns once shutdown is *initiated*; poll until the
    // entry actually leaves the "loaded"/"loading" states. Preset's
    // stop-timeout defaults to 10s, so 30s of slack is plenty.
    wait_until_unloaded(port, api_key, model_id, Duration::from_secs(30))
        .await
        .map_err(|e| format!("{}", e))
}

async fn wait_until_unloaded(
    port: u16,
    api_key: &str,
    model_id: &str,
    timeout: Duration,
) -> ServerResult<()> {
    let client = http_client().await;
    let url = format!("http://127.0.0.1:{}/models", port);
    let start = std::time::Instant::now();
    let poll_interval = Duration::from_millis(250);

    loop {
        let resp = client
            .get(&url)
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| {
                ServerError::Llamacpp(LlamacppError::new(
                    ErrorCode::InternalError,
                    "Failed to poll router /models".into(),
                    Some(e.to_string()),
                ))
            })?;
        let json: serde_json::Value = resp.json().await.map_err(|e| {
            ServerError::Llamacpp(LlamacppError::new(
                ErrorCode::InternalError,
                "Invalid JSON from /models".into(),
                Some(e.to_string()),
            ))
        })?;

        let entry = json
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(model_id))
            });

        // No entry at all → treat as unloaded.
        let still_loaded = entry
            .and_then(|e| e.get("status"))
            .and_then(|s| s.get("value"))
            .and_then(|v| v.as_str())
            .map(|v| matches!(v, "loaded" | "loading"))
            .unwrap_or(false);
        if !still_loaded {
            return Ok(());
        }

        if start.elapsed() >= timeout {
            return Err(ServerError::Llamacpp(LlamacppError::new(
                ErrorCode::InternalError,
                format!("Timed out waiting for model {} to unload", model_id),
                Some(format!("waited {:?}", timeout)),
            )));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

async fn unload_busy_router_models(port: u16, api_key: &str) -> Result<(), String> {
    let client = http_client().await;
    let list_url = format!("http://127.0.0.1:{}/models", port);
    let resp = client
        .get(&list_url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = json
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let unload_url = format!("http://127.0.0.1:{}/models/unload", port);
    for m in &data {
        let Some(id) = m.get("id").and_then(|v| v.as_str()) else { continue };
        let status = m
            .get("status")
            .and_then(|s| s.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("unloaded");
        if status.eq_ignore_ascii_case("unloaded") {
            continue;
        }
        let body = serde_json::json!({ "model": id });
        match client
            .post(&unload_url)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                log::info!("OOM unload: {} ({})", id, status);
            }
            Ok(r) => log::warn!("OOM unload {} returned {}", id, r.status()),
            Err(e) => log::warn!("OOM unload {} failed: {}", id, e),
        }
    }
    Ok(())
}

async fn router_loaded_model_ids(port: u16, api_key: &str) -> Result<Vec<String>, String> {
    // Router-aware listing: `/models` (not `/v1/models`, which is OAI-compat
    // and returns a single element). Each entry has a `status` object whose
    // `value` is one of "loaded" / "loading" / "unloaded" / "sleeping".
    let client = http_client().await;
    let url = format!("http://127.0.0.1:{}/models", port);
    let resp = client
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("Failed to query /models: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("/models returned {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from /models: {}", e))?;
    let data = json
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let mut ids = Vec::new();
    for m in &data {
        let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let loaded = m
            .get("status")
            .and_then(|s| s.get("value"))
            .and_then(|v| v.as_str())
            .map(|s| s.eq_ignore_ascii_case("loaded"))
            .unwrap_or(false);
        if loaded {
            ids.push(id.to_string());
        }
    }
    Ok(ids)
}

#[tauri::command]
pub async fn load_llama_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
    is_embedding: bool,
) -> ServerResult<SessionInfo> {
    let (port, api_key, pid) = router_endpoint(&app_handle)
        .await
        .map_err(ServerError::InvalidArgument)?;
    post_load(&app_handle, port, &api_key, &model_id).await?;
    Ok(SessionInfo {
        pid: pid as i32,
        port: port as i32,
        model_id,
        is_embedding,
        api_key,
    })
}

#[tauri::command]
pub async fn unload_llama_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
) -> ServerResult<UnloadResult> {
    let (port, api_key, _pid) = router_endpoint(&app_handle)
        .await
        .map_err(ServerError::InvalidArgument)?;
    match post_unload(port, &api_key, &model_id).await {
        Ok(()) => Ok(UnloadResult { success: true, error: None }),
        Err(e) => Ok(UnloadResult { success: false, error: Some(e) }),
    }
}

#[tauri::command]
pub async fn get_devices(
    backend_path: &str,
    envs: HashMap<String, String>,
) -> ServerResult<Vec<DeviceInfo>> {
    get_devices_from_backend(backend_path, envs).await
}

#[tauri::command]
pub fn generate_api_key(model_id: String, api_secret: String) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(api_secret.as_bytes())
        .map_err(|e| format!("Invalid key length: {}", e))?;
    mac.update(model_id.as_bytes());
    let result = mac.finalize();
    let code_bytes = result.into_bytes();
    let hash = general_purpose::STANDARD.encode(code_bytes);
    Ok(hash)
}

#[tauri::command]
pub async fn ensure_session_ready<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
    is_embedding: bool,
) -> Result<SessionInfo, String> {
    let (port, api_key, pid) = router_endpoint(&app_handle).await?;
    post_load(&app_handle, port, &api_key, &model_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(SessionInfo {
        pid: pid as i32,
        port: port as i32,
        model_id,
        is_embedding,
        api_key,
    })
}

#[tauri::command]
pub async fn find_session_by_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
) -> Result<Option<SessionInfo>, String> {
    let (port, api_key, pid) = match router_endpoint(&app_handle).await {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let ids = router_loaded_model_ids(port, &api_key).await?;
    if ids.iter().any(|id| id == &model_id) {
        Ok(Some(SessionInfo {
            pid: pid as i32,
            port: port as i32,
            model_id,
            is_embedding: false,
            api_key,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn get_loaded_models<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    let (port, api_key, _pid) = match router_endpoint(&app_handle).await {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    router_loaded_model_ids(port, &api_key).await
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct RouterInfo {
    pub port: u16,
    pub api_key: String,
    pub pid: u32,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_router<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    backend_exe: String,
    preset_path: String,
    port: u16,
    api_key: String,
    models_max: u32,
    default_args: Vec<String>,
    envs: HashMap<String, String>,
) -> Result<RouterInfo, String> {
    let state: State<Arc<LlamacppState>> = app_handle.state();
    let mut guard = state.router.lock().await;
    if guard.is_some() {
        return Err("Router is already running.".to_string());
    }

    let on_error: Option<crate::router::ErrorCallback> = {
        let app = app_handle.clone();
        let err_port = port;
        let err_api_key = api_key.clone();
        Some(Arc::new(move |kind: &'static str, line: String| {
            let event = match kind {
                "oom" => "llamacpp-router-oom",
                _ => "llamacpp-router-backend-error",
            };
            let _ = app.emit(event, line);
            let port = err_port;
            let api_key = err_api_key.clone();
            tokio::spawn(async move {
                if let Err(e) = unload_busy_router_models(port, &api_key).await {
                    log::warn!("router error unload sweep failed: {}", e);
                }
            });
        }))
    };

    let handle = crate::router::start_router(
        std::path::PathBuf::from(backend_exe),
        std::path::PathBuf::from(preset_path),
        port,
        api_key,
        models_max,
        default_args,
        envs,
        on_error,
    )
    .await
    .map_err(|e| e.to_string())?;

    let info = RouterInfo {
        port: handle.port,
        api_key: handle.api_key.clone(),
        pid: handle.pid,
    };
    state
        .router_pid
        .store(handle.pid, std::sync::atomic::Ordering::SeqCst);
    *guard = Some(handle);
    Ok(info)
}

#[tauri::command]
pub async fn stop_router<R: Runtime>(app_handle: tauri::AppHandle<R>) -> Result<(), String> {
    let state: State<Arc<LlamacppState>> = app_handle.state();
    let mut guard = state.router.lock().await;
    if let Some(handle) = guard.take() {
        state
            .router_pid
            .store(0, std::sync::atomic::Ordering::SeqCst);
        crate::router::stop_router(handle)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_router_info<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Option<RouterInfo>, String> {
    let state: State<Arc<LlamacppState>> = app_handle.state();
    let guard = state.router.lock().await;
    Ok(guard.as_ref().map(|h| RouterInfo {
        port: h.port,
        api_key: h.api_key.clone(),
        pid: h.pid,
    }))
}

/// Live-reload the router's preset (`GET /models?reload=1`) without restarting
/// the process. The router diffs the regenerated `router.preset.ini` against the
/// running set: models with unchanged presets stay loaded, only changed/removed
/// ones are unloaded, and newly-added ones are registered. Requires a backend
/// with the reload diff path (upstream b9023+); the TS caller gates on build.
#[tauri::command]
pub async fn reload_router_models<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<(), String> {
    let (port, api_key, _pid) = router_endpoint(&app_handle).await?;
    let client = http_client().await;
    let url = format!("http://127.0.0.1:{}/models", port);
    let resp = client
        .get(&url)
        .query(&[("reload", "1")])
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "router reload returned HTTP {}",
            resp.status().as_u16()
        ));
    }
    Ok(())
}

/// Best-effort idle check; returns `Ok(true)` on any error so callers
/// never block on a transient `/slots` failure.
#[tauri::command]
pub async fn router_slots_idle<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: Option<String>,
) -> Result<bool, String> {
    let (port, api_key, _pid) = match router_endpoint(&app_handle).await {
        Ok(r) => r,
        Err(_) => return Ok(true),
    };
    let client = http_client().await;
    let url = format!("http://127.0.0.1:{}/slots", port);
    let mut req = client.get(&url).bearer_auth(&api_key);
    if let Some(m) = model_id.as_deref() {
        req = req.query(&[("model", m)]);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return Ok(true),
    };
    if !resp.status().is_success() {
        return Ok(true);
    }
    let slots: Vec<serde_json::Value> = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(true),
    };
    Ok(slots.iter().all(|s| {
        s.get("is_processing")
            .and_then(|v| v.as_bool())
            .map(|b| !b)
            .unwrap_or(true)
    }))
}

/// `Ok(Some(busy))` on deadline; handle is restored to state.
#[tauri::command]
pub async fn try_graceful_stop_router<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    deadline_secs: u64,
) -> Result<Option<Vec<String>>, String> {
    let state: State<Arc<LlamacppState>> = app_handle.state();
    let maybe_handle = {
        let mut guard = state.router.lock().await;
        guard.take()
    };
    let Some(handle) = maybe_handle else {
        return Ok(None);
    };
    match crate::router::try_graceful_stop_router(handle, Duration::from_secs(deadline_secs)).await {
        Ok(()) => {
            state
                .router_pid
                .store(0, std::sync::atomic::Ordering::SeqCst);
            Ok(None)
        }
        Err((h, busy)) => {
            let mut guard = state.router.lock().await;
            *guard = Some(h);
            Ok(Some(busy))
        }
    }
}

/// Issues `POST /models/unload` for `model_id` only if `/slots?model=<id>`
/// reports `is_processing: true`. Returns whether an unload was triggered.
#[tauri::command]
pub async fn force_stop_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
) -> Result<bool, String> {
    let (port, api_key, _pid) = router_endpoint(&app_handle).await?;
    let client = http_client().await;

    let slots_url = format!("http://127.0.0.1:{}/slots", port);
    let resp = client
        .get(&slots_url)
        .query(&[("model", model_id.as_str())])
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(false);
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let busy = json
        .as_array()
        .map(|arr| {
            arr.iter().any(|s| {
                s.get("is_processing")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if !busy {
        return Ok(false);
    }

    let url = format!("http://127.0.0.1:{}/models/unload", port);
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&ModelRequestBody { model: &model_id })
        .send()
        .await
        .map_err(|e| e.to_string())?;
    log::info!(
        "force_stop_model: unload {} returned {}",
        model_id,
        resp.status()
    );
    Ok(true)
}

#[tauri::command]
pub async fn force_kill_router_tree<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<(), String> {
    let state: State<Arc<LlamacppState>> = app_handle.state();
    let pid = state
        .router_pid
        .swap(0, std::sync::atomic::Ordering::SeqCst);
    let maybe_handle = {
        let mut guard = state.router.lock().await;
        guard.take()
    };
    match (maybe_handle, pid) {
        (Some(handle), _) => crate::router::force_kill_router_tree(handle).await,
        (None, p) if p != 0 => crate::router::force_kill_router_tree_by_pid(p),
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod load_progress_tests {
    use super::parse_load_progress_event;

    fn sse_block(model: &str, event: &str, data: serde_json::Value) -> String {
        let payload = serde_json::json!({ "model": model, "event": event, "data": data });
        format!("data: {}\n\n", payload)
    }

    #[test]
    fn parses_a_matching_progress_event() {
        let block = sse_block(
            "model-1",
            "status_change",
            serde_json::json!({
                "status": "loading",
                "progress": { "stages": ["text_model"], "current": "text_model", "value": 0.42 }
            }),
        );
        let payload = parse_load_progress_event(&block, "model-1").expect("should parse");
        assert_eq!(payload.model, "model-1");
        assert_eq!(payload.stage.as_deref(), Some("text_model"));
        assert!((payload.value - 0.42).abs() < f64::EPSILON);
    }

    #[test]
    fn ignores_events_for_a_different_model() {
        let block = sse_block(
            "other-model",
            "status_change",
            serde_json::json!({ "progress": { "current": "text_model", "value": 0.5 } }),
        );
        assert!(parse_load_progress_event(&block, "model-1").is_none());
    }

    #[test]
    fn ignores_non_status_change_events() {
        let block = sse_block(
            "model-1",
            "download_progress",
            serde_json::json!({ "done": 10, "total": 100 }),
        );
        assert!(parse_load_progress_event(&block, "model-1").is_none());
    }

    #[test]
    fn ignores_status_change_without_progress() {
        let block = sse_block("model-1", "status_change", serde_json::json!({ "status": "loaded" }));
        assert!(parse_load_progress_event(&block, "model-1").is_none());
    }

    #[test]
    fn ignores_null_progress() {
        let block = sse_block(
            "model-1",
            "status_change",
            serde_json::json!({ "status": "loaded", "progress": null }),
        );
        assert!(parse_load_progress_event(&block, "model-1").is_none());
    }

    #[test]
    fn ignores_malformed_json() {
        let block = "data: not json at all\n\n".to_string();
        assert!(parse_load_progress_event(&block, "model-1").is_none());
    }

    #[test]
    fn ignores_blocks_with_no_data_line() {
        let block = "event: ping\n\n".to_string();
        assert!(parse_load_progress_event(&block, "model-1").is_none());
    }

    #[test]
    fn defaults_missing_value_to_zero() {
        let block = sse_block(
            "model-1",
            "status_change",
            serde_json::json!({ "progress": { "current": "text_model" } }),
        );
        let payload = parse_load_progress_event(&block, "model-1").expect("should parse");
        assert_eq!(payload.value, 0.0);
        assert_eq!(payload.stage.as_deref(), Some("text_model"));
    }

    #[test]
    fn defaults_missing_stage_to_none() {
        let block = sse_block(
            "model-1",
            "status_change",
            serde_json::json!({ "progress": { "value": 0.9 } }),
        );
        let payload = parse_load_progress_event(&block, "model-1").expect("should parse");
        assert!(payload.stage.is_none());
    }
}
