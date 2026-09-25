use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio::time::Instant;

use crate::error::{ErrorCode, MlxError, ServerError, ServerResult};
use crate::process::{
    find_session_by_model_id, get_all_active_sessions, get_all_loaded_model_ids,
    get_random_available_port, is_process_running_by_pid,
};
use crate::state::{MlxBackendSession, MlxState, SessionInfo};

#[cfg(unix)]
use crate::process::graceful_terminate_process;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct UnloadResult {
    success: bool,
    error: Option<String>,
}

/// MLX server configuration passed from the frontend
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MlxConfig {
    #[serde(default)]
    pub ctx_size: i32,
}

/// Ports claimed by loads that have not reached the session map yet. The map
/// is no longer locked across a load (#71), so without this two concurrent
/// loads could both be handed, and both launch on, the same port.
static PENDING_PORTS: std::sync::Mutex<Vec<u16>> = std::sync::Mutex::new(Vec::new());

/// Ports reserved by in-flight loads, for the random-port picker to avoid.
pub(crate) fn pending_ports() -> Vec<u16> {
    PENDING_PORTS.lock().map(|p| p.clone()).unwrap_or_default()
}

/// A port held for one in-flight load; released when dropped.
struct PortReservation(u16);

impl Drop for PortReservation {
    fn drop(&mut self) {
        if let Ok(mut pending) = PENDING_PORTS.lock() {
            pending.retain(|p| *p != self.0);
        }
    }
}

/// Claim `port` for a load, or `None` when another load already holds it.
fn reserve_port(port: u16) -> Option<PortReservation> {
    let mut pending = PENDING_PORTS.lock().ok()?;
    if pending.contains(&port) {
        return None;
    }
    pending.push(port);
    Some(PortReservation(port))
}

fn port_in_use(port: u16) -> ServerError {
    MlxError::new(
        ErrorCode::ModelLoadFailed,
        format!("Port {port} is already used by another MLX model."),
        None,
    )
    .into()
}

/// Core model-loading logic, decoupled from Tauri AppHandle.
/// `binary_path` must point to the mlx-server executable.
/// `process_map_arc` is the shared session map from MlxState.
#[allow(clippy::too_many_arguments)]
pub async fn load_mlx_model_impl(
    process_map_arc: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    binary_path: &Path,
    model_id: String,
    model_path: String,
    port: u16,
    config: MlxConfig,
    envs: HashMap<String, String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    // The session map is locked only to insert the finished session (below).
    // Holding it across the readiness wait would stall every other MLX
    // command (lookup, unload, chat, shutdown cleanup) for up to `timeout`.

    log::info!("Attempting to launch MLX server at path: {:?}", binary_path);
    log::info!("Using MLX configuration: {:?}", config);

    // Validate binary path
    let bin_path = PathBuf::from(binary_path);
    if !bin_path.exists() {
        return Err(MlxError::new(
            ErrorCode::BinaryNotFound,
            format!("MLX server binary not found at: {}", binary_path.display()),
            None,
        )
        .into());
    }

    // Validate model path
    let model_path_pb = PathBuf::from(&model_path);
    if !model_path_pb.exists() {
        return Err(MlxError::new(
            ErrorCode::ModelFileNotFound,
            format!("Model file not found at: {}", model_path),
            None,
        )
        .into());
    }

    // Port 0 lets the OS choose, so there is nothing to collide on.
    let _reservation = if port == 0 {
        None
    } else {
        let reservation = reserve_port(port).ok_or_else(|| port_in_use(port))?;
        let taken = process_map_arc
            .lock()
            .await
            .values()
            .any(|s| s.info.port == i32::from(port));
        if taken {
            return Err(port_in_use(port));
        }
        Some(reservation)
    };

    let api_key: String = envs
        .get("MLX_API_KEY")
        .map(|s| s.to_string())
        .unwrap_or_default();

    // Build command arguments
    let mut args: Vec<String> = vec![
        "--model".to_string(),
        model_path.clone(),
        "--port".to_string(),
        port.to_string(),
        "--model-id".to_string(),
        model_id.clone(),
    ];

    if config.ctx_size > 0 {
        args.push("--ctx-size".to_string());
        args.push(config.ctx_size.to_string());
    }

    if !api_key.is_empty() {
        args.push("--api-key".to_string());
        args.push(api_key.clone());
    }

    log::info!("MLX server arguments: {:?}", args);

    // Configure the command
    let mut command = Command::new(&bin_path);
    command.args(&args);
    command.envs(envs);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // The map is not locked during the load, so an exit cleanup can run
    // while this future is pending; dropping it must not orphan the server.
    command.kill_on_drop(true);

    // Spawn the child process
    let mut child = command.spawn().map_err(ServerError::Io)?;

    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout = child.stdout.take().expect("stdout was piped");

    // Create channels for communication between tasks
    let (ready_tx, mut ready_rx) = mpsc::channel::<bool>(1);

    // Spawn task to monitor stdout for readiness
    let stdout_ready_tx = ready_tx.clone();
    let _stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut byte_buffer = Vec::new();

        loop {
            byte_buffer.clear();
            match reader.read_until(b'\n', &mut byte_buffer).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&byte_buffer);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        log::info!("[mlx stdout] {}", line);
                    }

                    let line_lower = line.to_lowercase();
                    if line_lower.contains("http server listening")
                        || line_lower.contains("server is listening")
                        || line_lower.contains("server started")
                        || line_lower.contains("ready to accept")
                        || line_lower.contains("server started and listening on")
                    {
                        log::info!(
                            "MLX server appears to be ready based on stdout: '{}'",
                            line
                        );
                        let _ = stdout_ready_tx.send(true).await;
                    }
                }
                Err(e) => {
                    log::error!("Error reading MLX stdout: {}", e);
                    break;
                }
            }
        }
    });

    // Spawn task to capture stderr and monitor for errors
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut byte_buffer = Vec::new();
        let mut stderr_buffer = String::new();

        loop {
            byte_buffer.clear();
            match reader.read_until(b'\n', &mut byte_buffer).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&byte_buffer);
                    let line = line.trim_end();

                    if !line.is_empty() {
                        stderr_buffer.push_str(line);
                        stderr_buffer.push('\n');
                        log::info!("[mlx] {}", line);

                        let line_lower = line.to_lowercase();
                        if line_lower.contains("server is listening")
                            || line_lower.contains("server listening on")
                            || line_lower.contains("server started and listening on")
                        {
                            log::info!(
                                "MLX model appears to be ready based on logs: '{}'",
                                line
                            );
                            let _ = ready_tx.send(true).await;
                        }
                    }
                }
                Err(e) => {
                    log::error!("Error reading MLX logs: {}", e);
                    break;
                }
            }
        }

        stderr_buffer
    });

    // Check if process exited early
    if let Some(status) = child.try_wait()? {
        if !status.success() {
            let stderr_output = stderr_task.await.unwrap_or_else(|e| {
                        log::warn!("MLX stderr task join failed: {e}");
                        String::new()
                    });
            log::error!("MLX server failed early with code {:?}", status);
            log::error!("{}", stderr_output);
            return Err(MlxError::from_stderr(&stderr_output).into());
        }
    }

    // Wait for server to be ready or timeout
    let timeout_duration = Duration::from_secs(timeout);
    let start_time = Instant::now();
    log::info!("Waiting for MLX model session to be ready...");

    loop {
        tokio::select! {
            Some(true) = ready_rx.recv() => {
                log::info!("MLX model is ready to accept requests!");
                break;
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if let Some(status) = child.try_wait()? {
                    let stderr_output = stderr_task.await.unwrap_or_else(|e| {
                        log::warn!("MLX stderr task join failed: {e}");
                        String::new()
                    });
                    if !status.success() {
                        log::error!("MLX server exited with error code {:?}", status);
                        return Err(MlxError::from_stderr(&stderr_output).into());
                    } else {
                        log::error!("MLX server exited successfully but without ready signal");
                        return Err(MlxError::from_stderr(&stderr_output).into());
                    }
                }

                if start_time.elapsed() > timeout_duration {
                    log::error!("Timeout waiting for MLX server to be ready");
                    let _ = child.kill().await;
                    let stderr_output = stderr_task.await.unwrap_or_else(|e| {
                        log::warn!("MLX stderr task join failed: {e}");
                        String::new()
                    });
                    return Err(MlxError::new(
                        ErrorCode::ModelLoadTimedOut,
                        "The MLX model took too long to load and timed out.".into(),
                        Some(format!(
                            "Timeout: {}s\n\nStderr:\n{}",
                            timeout_duration.as_secs(),
                            stderr_output
                        )),
                    )
                    .into());
                }
            }
        }
    }

    let pid = child.id().map(|id| id as i32).unwrap_or(-1);

    log::info!("MLX server process started with PID: {} and is ready", pid);
    let session_info = SessionInfo {
        pid,
        port: port.into(),
        model_id,
        model_path: model_path_pb.display().to_string(),
        is_embedding,
        api_key,
    };

    process_map_arc.lock().await.insert(
        pid,
        MlxBackendSession {
            child,
            info: session_info.clone(),
        },
    );

    Ok(session_info)
}

/// Load a model using the MLX server binary (Tauri command wrapper)
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn load_mlx_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
    model_path: String,
    port: u16,
    config: MlxConfig,
    envs: HashMap<String, String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    let state: State<MlxState> = app_handle.state();
    let binary_path = app_handle
        .path()
        .resource_dir()
        .map_err(|e| {
            MlxError::new(
                ErrorCode::BinaryNotFound,
                "Failed to get resource dir".to_string(),
                Some(e.to_string()),
            )
        })?
        .join("resources/bin/mlx-server");
    load_mlx_model_impl(
        state.mlx_server_process.clone(),
        &binary_path,
        model_id,
        model_path,
        port,
        config,
        envs,
        is_embedding,
        timeout,
    )
    .await
}

/// Unload an MLX model by terminating its process
#[tauri::command]
pub async fn unload_mlx_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> ServerResult<UnloadResult> {
    let state: State<MlxState> = app_handle.state();
    Ok(unload_mlx_model_impl(state.mlx_server_process.clone(), pid).await)
}

/// Core unload logic, decoupled from Tauri AppHandle.
///
/// A PID that is not tracked is reported as a failure: the caller asked to
/// unload something this plugin never started (or already unloaded), and a
/// `success: true` there would be indistinguishable from a real termination.
pub async fn unload_mlx_model_impl(
    process_map_arc: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    pid: i32,
) -> UnloadResult {
    // Take the session out under the lock, then release it before waiting
    // for the process to exit.
    let session = process_map_arc.lock().await.remove(&pid);

    if let Some(session) = session {
        #[allow(unused_mut)]
        let mut child = session.child;

        #[cfg(unix)]
        {
            graceful_terminate_process(&mut child).await;
        }
        #[cfg(not(unix))]
        drop(child);

        UnloadResult {
            success: true,
            error: None,
        }
    } else {
        log::warn!("No MLX server with PID '{}' found", pid);
        UnloadResult {
            success: false,
            error: Some(format!("No MLX server with PID '{}' found", pid)),
        }
    }
}

/// Check if a process is still running
#[tauri::command]
pub async fn is_mlx_process_running<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<bool, String> {
    is_process_running_by_pid(app_handle, pid).await
}

/// Get a random available port
#[tauri::command]
pub async fn get_mlx_random_port<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<u16, String> {
    get_random_available_port(app_handle).await
}

/// Find session information by model ID
#[tauri::command]
pub async fn find_mlx_session_by_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
) -> Result<Option<SessionInfo>, String> {
    find_session_by_model_id(app_handle, &model_id).await
}

/// Get all loaded model IDs
#[tauri::command]
pub async fn get_mlx_loaded_models<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    get_all_loaded_model_ids(app_handle).await
}

/// Get all active sessions
#[tauri::command]
pub async fn get_mlx_all_sessions<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<SessionInfo>, String> {
    get_all_active_sessions(app_handle).await
}

#[cfg(all(test, unix))]
mod load_lock_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    // Regression for #71: the session map must stay lockable while a model
    // load is waiting for the server to become ready.
    #[tokio::test]
    async fn session_map_is_not_locked_during_the_readiness_wait() {
        let dir = std::env::temp_dir().join(format!("mlx-lock-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-mlx-server");
        std::fs::write(&bin, "#!/bin/sh\nsleep 5\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let model = dir.join("model.safetensors");
        std::fs::write(&model, b"").unwrap();

        let map: Arc<Mutex<HashMap<i32, MlxBackendSession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (map2, bin2, model2) = (map.clone(), bin.clone(), model.display().to_string());
        let load = tokio::spawn(async move {
            load_mlx_model_impl(
                map2,
                &bin2,
                "m".into(),
                model2,
                0,
                MlxConfig { ctx_size: 0 },
                HashMap::new(),
                false,
                2,
            )
            .await
        });

        // Give the load time to spawn the child and enter its wait loop.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let lock = tokio::time::timeout(Duration::from_millis(500), map.lock()).await;
        assert!(lock.is_ok(), "session map stayed locked during the model load");
        drop(lock);

        let result = load.await.unwrap();
        assert!(result.is_err(), "fake server never signals readiness");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // #71: releasing the lock during the load must not lose the session a
    // successful load inserts.
    #[tokio::test]
    async fn a_successful_load_inserts_the_session() {
        let dir = std::env::temp_dir().join(format!("mlx-insert-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("fake-mlx-server");
        std::fs::write(&bin, "#!/bin/sh\necho 'http server listening'\nsleep 30\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let model = dir.join("model.safetensors");
        std::fs::write(&model, b"").unwrap();

        let map: Arc<Mutex<HashMap<i32, MlxBackendSession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let info = load_mlx_model_impl(
            map.clone(),
            &bin,
            "m".into(),
            model.display().to_string(),
            0,
            MlxConfig { ctx_size: 0 },
            HashMap::new(),
            false,
            5,
        )
        .await
        .expect("the fake server signals readiness");
        assert!(map.lock().await.contains_key(&info.pid));

        let unloaded = unload_mlx_model_impl(map, info.pid).await;
        assert!(unloaded.success);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression for #160: unloading an untracked PID must not report success.
    #[tokio::test]
    async fn unloading_an_untracked_pid_reports_failure() {
        let map: Arc<Mutex<HashMap<i32, MlxBackendSession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let result = unload_mlx_model_impl(map, 4242).await;
        assert!(!result.success);
        assert!(result.error.as_deref().unwrap_or("").contains("4242"));
    }

    // #71: two in-flight loads cannot hold the same port.
    #[test]
    fn a_port_is_reserved_for_one_load_at_a_time() {
        let port = 59_171;
        let first = reserve_port(port).expect("free port");
        assert!(reserve_port(port).is_none(), "second load got the same port");
        assert!(pending_ports().contains(&port));
        drop(first);
        assert!(!pending_ports().contains(&port));
        assert!(reserve_port(port).is_some(), "released on drop");
    }
}
