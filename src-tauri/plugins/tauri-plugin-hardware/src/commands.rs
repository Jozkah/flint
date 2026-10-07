use crate::types::{SystemInfo, SystemUsage};

// Hardware probes block (GPU enumeration, a CPU sampling sleep, and on Windows a
// performance-counter query that can pump COM messages). A synchronous command
// runs on the main thread, where that froze the window, so each one runs on a
// blocking thread like `get_system_snapshot` does.
#[tauri::command]
pub async fn get_system_info() -> SystemInfo {
    tauri::async_runtime::spawn_blocking(crate::get_system_info)
        .await
        .expect("system info task panicked")
}

/// Detailed snapshot for the System Monitor page (drives, network
/// counters, sensors, per-core CPU, swap, uptime).
#[tauri::command]
pub async fn get_system_snapshot() -> crate::snapshot::SystemSnapshot {
    tauri::async_runtime::spawn_blocking(crate::snapshot::get_system_snapshot)
        .await
        .expect("system snapshot task panicked")
}

#[tauri::command]
pub fn refresh_system_info() {
    crate::invalidate_system_info();
}

#[tauri::command]
pub async fn get_system_usage() -> SystemUsage {
    tauri::async_runtime::spawn_blocking(crate::sample_system_usage)
        .await
        .expect("system usage task panicked")
}
