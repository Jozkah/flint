use crate::types::{SystemInfo, SystemUsage};

// Hardware probes block (GPU enumeration, a CPU sampling sleep, and on Windows a
// performance-counter query that can pump COM messages). A synchronous command
// runs on the main thread, where that froze the window, so each one runs on a
// blocking thread like `get_system_snapshot` does.
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    tauri::async_runtime::spawn_blocking(crate::get_system_info)
        .await
        .map_err(|e| e.to_string())
}

/// Detailed snapshot for the System Monitor page (drives, network
/// counters, sensors, per-core CPU, swap, uptime).
#[tauri::command]
pub async fn get_system_snapshot() -> Result<crate::snapshot::SystemSnapshot, String> {
    tauri::async_runtime::spawn_blocking(crate::snapshot::get_system_snapshot)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn refresh_system_info() {
    crate::invalidate_system_info();
}

#[tauri::command]
pub async fn get_system_usage() -> Result<SystemUsage, String> {
    tauri::async_runtime::spawn_blocking(crate::sample_system_usage)
        .await
        .map_err(|e| e.to_string())
}
