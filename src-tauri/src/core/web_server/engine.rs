//! The local inference worker, supervised by the server.
//!
//! The engine runs in `flint-llama-worker`, a separate process, so a GPU
//! out-of-memory or device loss costs the model and not the server. The server
//! links no llama.cpp: it starts the worker binary, reads its handshake and
//! reports the loopback port and bearer key. A browser reaches the worker
//! through `/api/v1/provider/stream`, which dials loopback like any other
//! provider endpoint.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tauri_plugin_llamacpp::engine::worker::{self, WorkerHandle};
use tauri_plugin_llamacpp::LlamacppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub port: u16,
    pub api_key: String,
    pub pid: u32,
    pub models: Vec<String>,
    /// The last backend fault the worker logged, if any.
    pub fault: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub preset_path: String,
    #[serde(default = "one")]
    pub models_max: u32,
    #[serde(default)]
    pub slot_cache_mib: u64,
    #[serde(default)]
    pub envs: HashMap<String, String>,
}

fn one() -> u32 {
    1
}

pub struct Supervisor {
    /// The same state the desktop plugin keeps: its model-session calls work
    /// on it directly.
    pub state: LlamacppState,
    fault: Arc<StdMutex<Option<String>>>,
    exe: Option<PathBuf>,
    bus: super::events::Bus,
}

impl Supervisor {
    pub fn new(exe: Option<PathBuf>, bus: super::events::Bus) -> Self {
        Self {
            state: LlamacppState::new(),
            fault: Arc::new(StdMutex::new(None)),
            exe,
            bus,
        }
    }
}

/// Environment the worker may be given: backend selection and tuning only.
/// Anything that could redirect which code runs (`PATH`, `LD_*`, `DYLD_*`) or
/// replace its bearer key is refused.
fn env_allowed(key: &str) -> bool {
    const PREFIXES: [&str; 8] = ["GGML_", "LLAMA_", "CUDA_", "HIP_", "VK_", "ROCR_", "HSA_", "OMP_"];
    key != "JAN_LLAMA_API_KEY"
        && !llama_arg_redirects(key)
        && key.len() <= 64
        && key.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        && PREFIXES.iter().any(|p| key.starts_with(p))
}

/// `LLAMA_ARG_*` variables are llama.cpp command-line options. Tuning ones
/// (threads, timeout, batch sizes) are fine; any that binds a socket, swaps
/// the key, or names a file, URL, model or repo to load is not.
fn llama_arg_redirects(upper: &str) -> bool {
    if upper == "LLAMA_LOG_FILE" || upper == "LLAMA_CACHE" {
        return true;
    }
    let Some(rest) = upper.strip_prefix("LLAMA_ARG_") else {
        return false;
    };
    const MARKERS: [&str; 13] = [
        "HOST", "PORT", "API_KEY", "MODEL", "HF", "MMPROJ", "SSL", "FILE", "PATH", "URL", "DIR",
        "PRESET", "LORA",
    ];
    MARKERS.iter().any(|m| rest.contains(m))
}

fn clean_envs(envs: HashMap<String, String>) -> Result<HashMap<String, String>, String> {
    for (key, value) in &envs {
        if !env_allowed(key) {
            return Err(format!("environment variable {key} is not allowed for the engine"));
        }
        if value.len() > 4096 || value.contains('\0') {
            return Err(format!("environment variable {key} has an invalid value"));
        }
    }
    Ok(envs)
}

/// The preset is read by the worker and names model files, so it must live in
/// the data folder the server was given, not anywhere a request points.
pub fn confine_preset(data_folder: &Path, preset: &str) -> Result<PathBuf, String> {
    let base = std::fs::canonicalize(data_folder).map_err(|e| e.to_string())?;
    let file = std::fs::canonicalize(preset).map_err(|_| "preset file not found".to_string())?;
    if file.starts_with(&base) && file.is_file() {
        Ok(file)
    } else {
        Err("preset must be a file inside the data folder".into())
    }
}

fn worker_key() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn resolve_exe(supervisor: &Supervisor) -> Result<PathBuf, String> {
    let mut tried: Vec<PathBuf> = Vec::new();
    if let Some(path) = &supervisor.exe {
        tried.push(path.clone());
    }
    if let Some(path) = std::env::var_os("FLINT_LLAMA_WORKER_BIN") {
        tried.push(PathBuf::from(path));
    }
    if let Some(path) = worker::sidecar_candidate() {
        tried.push(path);
    }
    if let Some(found) = tried.iter().find(|p| p.is_file()) {
        return Ok(found.clone());
    }
    let list: Vec<String> = tried.iter().map(|p| p.display().to_string()).collect();
    Err(format!(
        "{} was not found (checked: {}). Build it with the engine feature, or pass --llama-worker.",
        worker::worker_file_name(),
        list.join(", ")
    ))
}

pub async fn start(
    supervisor: &Supervisor,
    data_folder: &Path,
    request: StartRequest,
) -> Result<Info, String> {
    let preset = confine_preset(data_folder, &request.preset_path)?;
    let mut guard = supervisor.state.engine.lock().await;
    if let Some(existing) = guard.as_mut() {
        if existing.exited().is_none() {
            // The client rewrote the preset (a model was added or removed)
            // and asks to start again: hand the running worker the new
            // preset, or a model added since spawn stays an unknown route
            // until the server restarts.
            let mut info = info_of(existing, &supervisor.fault);
            drop(guard);
            info.models = sync_preset(info.port, &info.api_key, &preset, info.models).await?;
            return Ok(info);
        }
        *guard = None;
    }
    let envs = clean_envs(request.envs)?;
    let exe = resolve_exe(supervisor)?;
    *supervisor.fault.lock().unwrap() = None;
    let fault = supervisor.fault.clone();
    let bus = supervisor.bus.clone();
    let on_fault: worker::FaultCallback = Arc::new(move |kind, line| {
        eprintln!("flint-llama-worker fault ({kind:?}): {line}");
        bus.publish(kind.event_name(), &line);
        *fault.lock().unwrap() = Some(line);
    });
    let offload_bus = supervisor.bus.clone();
    let on_offload: worker::OffloadCallback =
        Arc::new(move |report| offload_bus.publish("llamacpp-offload", &report));
    let key = worker_key();
    let handle = worker::spawn_with_offload(
        &exe,
        &preset,
        0,
        &key,
        request.models_max.max(1),
        request.slot_cache_mib,
        envs,
        Some(on_fault),
        Some(on_offload),
    )
    .await
    .map_err(|e| e.to_string())?;
    let info = info_of(&handle, &supervisor.fault);
    *guard = Some(handle);
    Ok(info)
}

/// Reload the running worker's models from `preset`; the models it now knows.
async fn sync_preset(port: u16, key: &str, preset: &Path, before: Vec<String>) -> Result<Vec<String>, String> {
    let report = tauri_plugin_llamacpp::engine::commands::reload_models_on(
        port,
        key,
        preset.to_string_lossy().into_owned(),
        None,
        None,
        None,
    )
    .await
    .map_err(|e| format!("could not apply the updated model list to the running engine: {e}"))?;
    let mut models: Vec<String> = report.kept.into_iter().chain(report.changed).chain(report.added).collect();
    if models.is_empty() && report.removed.is_empty() {
        models = before;
    }
    models.sort();
    models.dedup();
    Ok(models)
}

fn info_of(handle: &WorkerHandle, fault: &StdMutex<Option<String>>) -> Info {
    Info {
        port: handle.port,
        api_key: handle.api_key.clone(),
        pid: handle.pid,
        models: handle.models.clone(),
        fault: fault.lock().unwrap().clone(),
    }
}

/// The running worker, or `None`. A worker that died is dropped here so it is
/// never reported live against a closed port.
pub async fn info(supervisor: &Supervisor) -> Option<Info> {
    let mut guard = supervisor.state.engine.lock().await;
    if let Some(handle) = guard.as_mut() {
        if handle.exited().is_some() {
            *guard = None;
            return None;
        }
    }
    guard.as_ref().map(|h| info_of(h, &supervisor.fault))
}

pub async fn stop(supervisor: &Supervisor, force: bool) {
    let handle = supervisor.state.engine.lock().await.take();
    if let Some(handle) = handle {
        if force {
            handle.kill().await;
        } else {
            handle.stop().await;
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub mem: u64,
    pub free: u64,
}

/// Offloadable devices, asked of the worker with `--list-devices`: the server
/// has no ggml of its own to query.
pub async fn devices(supervisor: &Supervisor) -> Result<Vec<Device>, String> {
    let exe = resolve_exe(supervisor)?;
    let mut command = tokio::process::Command::new(&exe);
    command
        .arg("--list-devices")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "timed out enumerating devices".to_string())?
        .map_err(|e| format!("could not run {}: {e}", exe.display()))?;
    if !output.status.success() {
        return Err(format!(
            "device enumeration failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("unreadable device list: {e}"))
}

pub fn version() -> serde_json::Value {
    use tauri_plugin_llamacpp::engine::{PINNED_BUILD_NUMBER, PINNED_COMMIT, PINNED_TAG, PINNED_VERSION};
    serde_json::json!({
        "version": PINNED_VERSION,
        "tag": PINNED_TAG,
        "buildNumber": PINNED_BUILD_NUMBER,
        "commit": PINNED_COMMIT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_environment_is_limited_to_backend_settings() {
        for ok in ["CUDA_VISIBLE_DEVICES", "GGML_VK_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "LLAMA_ARG_THREADS"] {
            assert!(env_allowed(ok), "{ok}");
        }
        for bad in ["PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "JAN_LLAMA_API_KEY", "cuda_visible", "GGML-X", "HOME", ""] {
            assert!(!env_allowed(bad), "{bad}");
        }
        for bad in ["LLAMA_ARG_HOST", "LLAMA_ARG_PORT", "LLAMA_ARG_API_KEY", "LLAMA_ARG_MODEL", "LLAMA_ARG_MODEL_URL", "LLAMA_ARG_HF_REPO", "LLAMA_ARG_SSL_KEY_FILE", "LLAMA_LOG_FILE"] {
            assert!(!env_allowed(bad), "{bad}");
        }
        assert!(clean_envs(HashMap::from([("CUDA_VISIBLE_DEVICES".into(), "0".into())])).is_ok());
        assert!(clean_envs(HashMap::from([("PATH".into(), "x".into())])).is_err());
        assert!(clean_envs(HashMap::from([("GGML_A".into(), "a\0b".into())])).is_err());
    }

    #[test]
    fn presets_must_live_in_the_data_folder() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let inside = data.path().join("router.preset.ini");
        std::fs::write(&inside, "[*]\n").unwrap();
        let elsewhere = outside.path().join("evil.ini");
        std::fs::write(&elsewhere, "[*]\n").unwrap();
        assert!(confine_preset(data.path(), inside.to_str().unwrap()).is_ok());
        assert!(confine_preset(data.path(), elsewhere.to_str().unwrap()).is_err());
        let traversal = data.path().join("..").join(outside.path().file_name().unwrap()).join("evil.ini");
        assert!(confine_preset(data.path(), traversal.to_str().unwrap()).is_err());
        assert!(confine_preset(data.path(), data.path().to_str().unwrap()).is_err());
    }

    /// A worker on `port` that answers one `/models/reload` with `report`
    /// and hands back the request it got.
    async fn fake_worker(report: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let len = text[..head_end]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if got.len() >= head_end + 4 + len || n == 0 {
                        break;
                    }
                }
            }
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{report}",
                report.len()
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&got).to_string()
        });
        (port, task)
    }

    #[tokio::test]
    async fn a_running_worker_learns_models_added_to_the_preset() {
        let (port, request) = fake_worker(
            r#"{"added":["new-model"],"changed":[],"removed":[],"kept":["old-model"],"models_max":1}"#,
        )
        .await;
        let preset = Path::new("C:/data/router.preset.ini");
        let models = sync_preset(port, "k", preset, vec!["old-model".into()]).await.unwrap();
        assert_eq!(models, vec!["new-model".to_string(), "old-model".to_string()]);
        let request = request.await.unwrap();
        assert!(request.starts_with("POST /models/reload"), "{request}");
        assert!(request.contains("router.preset.ini"), "{request}");
    }

    #[tokio::test]
    async fn a_failed_reload_says_why() {
        // Nothing listens on a port just released.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let err = sync_preset(port, "k", Path::new("p.ini"), vec![]).await.unwrap_err();
        assert!(err.contains("updated model list"), "{err}");
    }

    #[tokio::test]
    async fn a_missing_worker_is_named_not_guessed() {
        let data = tempfile::tempdir().unwrap();
        let preset = data.path().join("p.ini");
        std::fs::write(&preset, "[*]\n").unwrap();
        let supervisor = Supervisor::new(Some(data.path().join("no-such-worker")), super::super::events::Bus::new());
        let error = start(
            &supervisor,
            data.path(),
            StartRequest {
                preset_path: preset.to_string_lossy().into_owned(),
                models_max: 1,
                slot_cache_mib: 0,
                envs: HashMap::new(),
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("no-such-worker"), "{error}");
        assert!(info(&supervisor).await.is_none());
    }
}
