#[cfg(feature = "tauri")]
mod commands;
mod constants;
pub mod cpu;
pub mod gpu;
pub mod snapshot;
mod types;
pub mod vendor;
mod windows_sensors;

pub use constants::*;
pub use types::*;

use std::sync::RwLock;

/// Cached system info. Uses Option so we can invalidate on Linux after sleep/resume
/// (GPU detection can return empty until the driver is ready again).
static SYSTEM_INFO: RwLock<Option<SystemInfo>> = RwLock::new(None);

/// Compute system hardware information (CPU, memory, GPUs).
///
/// Results are cached after the first call; subsequent calls return the cached
/// value. Use `invalidate_system_info()` to force re-detection.
pub fn get_system_info() -> SystemInfo {
    {
        let guard = SYSTEM_INFO.read().unwrap_or_else(|e| e.into_inner());
        if let Some(ref info) = *guard {
            return info.clone();
        }
    }
    let info = compute_system_info();
    {
        let mut guard = SYSTEM_INFO.write().unwrap_or_else(|e| e.into_inner());
        *guard = Some(info.clone());
    }
    info
}

/// Invalidates cached hardware info so the next `get_system_info()` re-detects GPUs.
pub fn invalidate_system_info() {
    #[cfg(target_os = "linux")]
    vendor::nvidia::invalidate_nvml();
    let mut guard = SYSTEM_INFO.write().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

fn compute_system_info() -> SystemInfo {
    use sysinfo::System;
    use vendor::{nvidia, vulkan};

    let mut system = System::new();
    system.refresh_memory();

    let mut gpu_map = std::collections::HashMap::new();
    for gpu in nvidia::get_nvidia_gpus() {
        gpu_map.insert(gpu.uuid.clone(), gpu);
    }

    let vulkan_gpus = vulkan::get_vulkan_gpus();

    for gpu in vulkan_gpus {
        match gpu_map.get_mut(&gpu.uuid) {
            Some(nvidia_gpu) => {
                nvidia_gpu.vulkan_info = gpu.vulkan_info;
            }
            None => {
                gpu_map.insert(gpu.uuid.clone(), gpu);
            }
        }
    }

    let os_type = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    };
    let os_name = System::long_os_version().unwrap_or("Unknown".to_string());

    SystemInfo {
        cpu: CpuStaticInfo::new(),
        os_type: os_type.to_string(),
        os_name,
        total_memory: system.total_memory() / 1024 / 1024,
        gpus: gpu_map.into_values().collect(),
    }
}

/// Initialize the hardware Tauri plugin (desktop builds only).
#[cfg(feature = "tauri")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("hardware")
        .invoke_handler(tauri::generate_handler![
            commands::get_system_info,
            commands::get_system_usage,
            commands::get_system_snapshot,
            commands::refresh_system_info
        ])
        .build()
}

#[cfg(test)]
mod tests;
