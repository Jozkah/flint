use std::collections::HashSet;
use sysinfo::{Pid, System};
use tauri::{Manager, Runtime, State};

use crate::state::{MlxState, SessionInfo};
use jan_utils::generate_random_port;

/// Check if a process is running by PID
pub async fn is_process_running_by_pid<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<bool, String> {
    let state: State<MlxState> = app_handle.state();
    let mut map = state.mlx_server_process.lock().await;

    // A tracked session is asked through its own child handle: no process
    // table walk per chat message.
    if let Some(session) = map.get_mut(&pid) {
        let alive = matches!(session.child.try_wait(), Ok(None));
        if !alive {
            map.remove(&pid);
        }
        return Ok(alive);
    }
    drop(map);

    // Not ours (or already reaped): look at just that pid.
    let mut system = System::new();
    let process_pid = Pid::from(pid as usize);
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[process_pid]), true);
    Ok(system.process(process_pid).is_some())
}

/// Get a random available port, avoiding ports used by existing sessions
pub async fn get_random_available_port<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<u16, String> {
    let state: State<MlxState> = app_handle.state();
    let map = state.mlx_server_process.lock().await;

    let mut used_ports: HashSet<u16> = map
        .values()
        .filter_map(|session| {
            if session.info.port > 0 && session.info.port <= u16::MAX as i32 {
                Some(session.info.port as u16)
            } else {
                None
            }
        })
        .collect();
    // A load still waiting for readiness is not in the map yet (#71).
    used_ports.extend(crate::commands::pending_ports());

    drop(map);

    pick_dynamic_port(&used_ports)
}

/// A free loopback port from the IANA dynamic range (49152-65535), so it does
/// not land on the 3000-4000 band dev servers use. Falls back to the shared
/// picker only if the whole range is somehow unusable.
fn pick_dynamic_port(used: &HashSet<u16>) -> Result<u16, String> {
    use std::hash::{BuildHasher, Hasher};
    const LOW: u32 = 49152;
    const SPAN: u32 = 65535 - LOW + 1;

    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u32(std::process::id());
    let start = (hasher.finish() % SPAN as u64) as u32;

    for i in 0..SPAN {
        let port = (LOW + (start + i) % SPAN) as u16;
        if used.contains(&port) {
            continue;
        }
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    generate_random_port(used)
}

#[cfg(test)]
mod port_tests {
    use super::*;

    #[test]
    fn dynamic_port_is_in_range_and_skips_used() {
        let mut used = HashSet::new();
        let first = pick_dynamic_port(&used).unwrap();
        assert!(first >= 49152);
        used.insert(first);
        let second = pick_dynamic_port(&used).unwrap();
        assert_ne!(first, second);
    }
}

/// Gracefully terminate a process on Unix systems (macOS)
#[cfg(unix)]
pub async fn graceful_terminate_process(child: &mut tokio::process::Child) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    use std::time::Duration;
    use tokio::time::timeout;

    if let Some(raw_pid) = child.id() {
        let raw_pid = raw_pid as i32;
        log::info!("Sending SIGTERM to MLX process PID {}", raw_pid);
        let _ = kill(Pid::from_raw(raw_pid), Signal::SIGTERM);

        match timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => log::info!("MLX process exited gracefully: {}", status),
            Ok(Err(e)) => log::error!("Error waiting after SIGTERM for MLX process: {}", e),
            Err(_) => {
                log::warn!(
                    "SIGTERM timed out for MLX PID {}; sending SIGKILL",
                    raw_pid
                );
                let _ = kill(Pid::from_raw(raw_pid), Signal::SIGKILL);
                match child.wait().await {
                    Ok(s) => log::info!("Force-killed MLX process exited: {}", s),
                    Err(e) => log::error!("Error waiting after SIGKILL for MLX process: {}", e),
                }
            }
        }
    }
}

/// Find a session by model ID
pub async fn find_session_by_model_id<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: &str,
) -> Result<Option<SessionInfo>, String> {
    let state: State<MlxState> = app_handle.state();
    let map = state.mlx_server_process.lock().await;

    let session_info = map
        .values()
        .find(|backend_session| backend_session.info.model_id == model_id)
        .map(|backend_session| backend_session.info.clone());

    Ok(session_info)
}

/// Get all loaded model IDs
pub async fn get_all_loaded_model_ids<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    let state: State<MlxState> = app_handle.state();
    let map = state.mlx_server_process.lock().await;

    let model_ids = map
        .values()
        .map(|backend_session| backend_session.info.model_id.clone())
        .collect();

    Ok(model_ids)
}

/// Get all active sessions
pub async fn get_all_active_sessions<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<SessionInfo>, String> {
    let state: State<MlxState> = app_handle.state();
    let map = state.mlx_server_process.lock().await;
    let sessions: Vec<SessionInfo> = map.values().map(|s| s.info.clone()).collect();
    Ok(sessions)
}
