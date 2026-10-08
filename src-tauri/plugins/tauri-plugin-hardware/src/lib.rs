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

/// Live CPU, memory and GPU usage. Blocks for the CPU sampling interval, so
/// call it off the async runtime.
pub fn sample_system_usage() -> SystemUsage {
    let mut system = sysinfo::System::new();
    system.refresh_memory();

    system.refresh_cpu_all();
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_all();

    let cpus = system.cpus();
    let cpu_usage =
        cpus.iter().map(|cpu| cpu.cpu_usage()).sum::<f32>() / (cpus.len().max(1) as f32);

    SystemUsage {
        cpu: cpu_usage,
        used_memory: system.used_memory() / 1024 / 1024,
        total_memory: system.total_memory() / 1024 / 1024,
        gpus: crate::get_system_info()
            .gpus
            .iter()
            .map(|gpu| gpu.get_usage())
            .collect(),
    }
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

    // HashMap order changes between runs; keep the GPU list (and the monitor
    // cards) in a stable order: CUDA index, then Vulkan index.
    let mut gpus: Vec<_> = gpu_map.into_values().collect();
    gpus.sort_by_key(|gpu| {
        (
            gpu.nvidia_info.as_ref().map_or(u64::MAX, |n| n.index as u64),
            gpu.vulkan_info.as_ref().map_or(u64::MAX, |v| v.index),
        )
    });

    SystemInfo {
        cpu: CpuStaticInfo::new(),
        os_type: os_type.to_string(),
        os_name,
        total_memory: system.total_memory() / 1024 / 1024,
        gpus,
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
