use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, System};
use tauri::{Manager, Runtime, State};

use crate::error::MlxError;
use crate::state::{MlxBackendSession, MlxState, SessionInfo, StderrTail};
use jan_utils::generate_random_port;

/// Why recently reaped servers died, by pid, until someone asks. A crash is
/// usually noticed by whichever command runs next (a model listing, say), not
/// by the chat request that hit the closed port, so the report waits here.
static CRASH_REPORTS: std::sync::Mutex<Vec<(i32, MlxError)>> = std::sync::Mutex::new(Vec::new());
const MAX_CRASH_REPORTS: usize = 8;

/// The captured stderr lines as one string.
pub(crate) fn tail_text(tail: &StderrTail) -> String {
    let mut out = String::new();
    if let Ok(tail) = tail.lock() {
        for line in tail.iter() {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Remove every session whose server has exited, recording why it died.
///
/// A crashed mlx-server used to stay in the map, so every following message
/// went to its closed port and failed with a bare network error. Reaped, the
/// model counts as unloaded and the next send starts a fresh server.
pub(crate) fn reap_dead_sessions(map: &mut HashMap<i32, MlxBackendSession>) -> Vec<i32> {
    let dead: Vec<(i32, String)> = map
        .iter_mut()
        .filter_map(|(pid, session)| match session.child.try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => Some((*pid, status.to_string())),
            Err(e) => Some((*pid, format!("unknown ({e})"))),
        })
        .collect();

    for (pid, status) in &dead {
        if let Some(session) = map.remove(pid) {
            let stderr = tail_text(&session.stderr_tail);
            let err = MlxError::from_crash(status, &stderr);
            log::error!(
                "MLX server for '{}' (PID {pid}) exited unexpectedly: {status}\n{stderr}",
                session.info.model_id
            );
            if let Ok(mut reports) = CRASH_REPORTS.lock() {
                reports.retain(|(p, _)| p != pid);
                if reports.len() == MAX_CRASH_REPORTS {
                    reports.remove(0);
                }
                reports.push((*pid, err));
            }
        }
    }
    dead.into_iter().map(|(pid, _)| pid).collect()
}

/// The recorded crash of `pid`, handed out once.
pub(crate) fn take_crash_report(pid: i32) -> Option<MlxError> {
    let mut reports = CRASH_REPORTS.lock().ok()?;
    let index = reports.iter().position(|(p, _)| *p == pid)?;
    Some(reports.remove(index).1)
}

/// Check if a process is running by PID.
///
/// A server this plugin started that has crashed answers with its crash as
/// a structured error (JSON, which `parseEngineError` on the web side reads),
/// once; after that, and for untracked pids, it is a plain `false`.
pub async fn is_process_running_by_pid<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<bool, String> {
    let state: State<MlxState> = app_handle.state();
    let mut map = state.mlx_server_process.lock().await;
    reap_dead_sessions(&mut map);

    // A tracked session is asked through its own child handle: no process
    // table walk per chat message.
    if map.contains_key(&pid) {
        return Ok(true);
    }
    drop(map);

    if let Some(err) = take_crash_report(pid) {
        return Err(serde_json::to_string(&err).unwrap_or(err.message));
    }

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
    let mut map = state.mlx_server_process.lock().await;
    reap_dead_sessions(&mut map);

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
    let mut map = state.mlx_server_process.lock().await;
    reap_dead_sessions(&mut map);

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
    let mut map = state.mlx_server_process.lock().await;
    reap_dead_sessions(&mut map);
    let sessions: Vec<SessionInfo> = map.values().map(|s| s.info.clone()).collect();
    Ok(sessions)
}

#[cfg(test)]
mod liveness_tests {
    use super::*;
    use crate::error::ErrorCode;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::time::Duration;

    fn shell(script: &str) -> tokio::process::Command {
        #[cfg(unix)]
        let mut c = {
            let mut c = tokio::process::Command::new("sh");
            c.arg("-c");
            c
        };
        #[cfg(windows)]
        let mut c = {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C");
            c
        };
        c.arg(script)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        c
    }

    fn session(child: tokio::process::Child, stderr: &[&str]) -> MlxBackendSession {
        let pid = child.id().unwrap_or(0) as i32;
        MlxBackendSession {
            child,
            info: SessionInfo {
                pid,
                port: 50_000,
                model_id: "m".into(),
                model_path: String::new(),
                is_embedding: false,
                api_key: "k".into(),
            },
            stderr_tail: Arc::new(std::sync::Mutex::new(
                stderr.iter().map(|s| s.to_string()).collect(),
            )),
        }
    }

    // janhq/jan#9438: a crashed server stayed in the map with its stale port.
    #[tokio::test]
    async fn a_dead_server_is_reaped_and_its_crash_reported_once() {
        let child = shell("exit 3").spawn().expect("spawn shell");
        let s = session(
            child,
            &["std::runtime_error: [metal::malloc] Attempting to allocate 21474836480 bytes"],
        );
        let pid = s.info.pid;
        let mut map = HashMap::from([(pid, s)]);

        let mut reaped = Vec::new();
        for _ in 0..100 {
            reaped = reap_dead_sessions(&mut map);
            if !reaped.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(reaped, vec![pid]);
        assert!(map.is_empty(), "dead session must leave the map");

        let err = take_crash_report(pid).expect("crash recorded");
        assert!(matches!(err.code, ErrorCode::PromptOutOfMemory), "{err:?}");
        assert!(err.details.as_deref().unwrap_or("").contains("metal::malloc"));
        assert!(take_crash_report(pid).is_none(), "handed out once");
    }

    #[tokio::test]
    async fn a_live_server_is_kept() {
        #[cfg(unix)]
        let script = "sleep 30";
        #[cfg(windows)]
        let script = "ping -n 30 127.0.0.1";
        let s = session(shell(script).spawn().expect("spawn shell"), &[]);
        let pid = s.info.pid;
        let mut map = HashMap::from([(pid, s)]);
        assert!(reap_dead_sessions(&mut map).is_empty());
        assert!(map.contains_key(&pid), "live session must be reused");
        assert!(take_crash_report(pid).is_none());
    }

    #[test]
    fn metal_malloc_on_a_running_server_is_a_prompt_oom() {
        let err = MlxError::from_crash(
            "signal: 6 (SIGABRT)",
            "libc++abi: terminating due to uncaught exception of type std::runtime_error: \
             [metal::malloc] Attempting to allocate 21474836480 bytes which is greater than \
             the maximum allowed buffer size of 17179869184 bytes.",
        );
        assert!(matches!(err.code, ErrorCode::PromptOutOfMemory), "{err:?}");
        assert!(err.message.contains("ran out of GPU memory on this prompt"));
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"PROMPT_OUT_OF_MEMORY\""), "{json}");
    }

    #[test]
    fn any_other_exit_is_engine_stopped() {
        let err = MlxError::from_crash("exit status: 1", "Traceback: KeyError: 'x'");
        assert!(matches!(err.code, ErrorCode::EngineStopped), "{err:?}");
        assert!(serde_json::to_string(&err).unwrap().contains("\"ENGINE_STOPPED\""));
    }
}
