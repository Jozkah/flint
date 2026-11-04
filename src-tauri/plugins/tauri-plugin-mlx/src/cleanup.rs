use tauri::{Manager, Runtime};

/// Stop one server: SIGTERM, a short grace period, then SIGKILL.
#[allow(unused_mut)]
async fn terminate(mut child: tokio::process::Child) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        use tokio::time::{timeout, Duration};

        if let Some(raw_pid) = child.id() {
            let raw_pid = raw_pid as i32;
            log::info!("Sending SIGTERM to MLX PID {} during shutdown", raw_pid);
            let _ = kill(Pid::from_raw(raw_pid), Signal::SIGTERM);

            match timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(status)) => {
                    log::info!("MLX process {} exited gracefully: {}", raw_pid, status)
                }
                Ok(Err(e)) => {
                    log::error!(
                        "Error waiting after SIGTERM for MLX process {}: {}",
                        raw_pid,
                        e
                    )
                }
                Err(_) => {
                    log::warn!(
                        "SIGTERM timed out for MLX PID {}; sending SIGKILL",
                        raw_pid
                    );
                    let _ = kill(Pid::from_raw(raw_pid), Signal::SIGKILL);
                    let _ = child.wait().await;
                }
            }
        }
    }
    #[cfg(not(unix))]
    drop(child);
}

pub async fn cleanup_processes<R: Runtime>(app_handle: &tauri::AppHandle<R>) {
    let app_state = match app_handle.try_state::<crate::state::MlxState>() {
        Some(state) => state,
        None => {
            log::warn!("MlxState not found in app_handle");
            return;
        }
    };
    // Take every session out under the lock and release it before waiting:
    // each stop can take its full grace period, and holding the map that long
    // stalled every other MLX command and made shutdown wait n * grace.
    let sessions: Vec<_> = {
        let mut map = app_state.mlx_server_process.lock().await;
        map.drain().map(|(_, session)| session).collect()
    };
    terminate_all(sessions.into_iter().map(|s| s.child).collect()).await;
}

/// Stop every server at once, so shutdown takes one grace period, not n.
async fn terminate_all(children: Vec<tokio::process::Child>) {
    let mut stops = tokio::task::JoinSet::new();
    for child in children {
        stops.spawn(terminate(child));
    }
    while stops.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    // Three servers that ignore SIGTERM each cost the 2s grace period; run
    // one after another that is 6s+, together it is about 2s.
    #[cfg(unix)]
    #[tokio::test]
    async fn stubborn_servers_are_stopped_in_parallel() {
        let mut children = Vec::new();
        for _ in 0..3 {
            children.push(
                tokio::process::Command::new("sh")
                    .args(["-c", "trap '' TERM; while :; do sleep 1; done"])
                    .kill_on_drop(true)
                    .spawn()
                    .expect("spawn sh"),
            );
        }
        // Let the shells install their trap before the signal arrives.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let started = std::time::Instant::now();
        terminate_all(children).await;
        assert!(
            started.elapsed() < std::time::Duration::from_millis(5000),
            "shutdown stopped the servers one at a time: {:?}",
            started.elapsed()
        );
    }
}

#[tauri::command]
pub async fn cleanup_mlx_processes<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<(), String> {
    cleanup_processes(&app_handle).await;
    Ok(())
}
