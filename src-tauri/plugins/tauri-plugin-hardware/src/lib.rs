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
static SYSTEM_INFO: RwLock<Option<(SystemInfo, std::time::Instant)>> = RwLock::new(None);

/// How long a snapshot with no GPUs is trusted. An empty list right after boot
/// or resume usually means the driver was not ready, not that there is no GPU,
/// so it is re-detected a few times instead of being cached for the session.
const EMPTY_GPU_RETRY: std::time::Duration = std::time::Duration::from_secs(30);

/// Re-detections of an empty GPU list before it is trusted until the next
/// `invalidate_system_info()`. Machines with no GPU (CPU-only boxes, VMs)
/// would otherwise redo NVML and Vulkan probing on every UI poll.
const MAX_EMPTY_GPU_RETRIES: u32 = 3;

static EMPTY_GPU_RETRIES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Serializes re-detection so concurrent polls do not probe in parallel.
static COMPUTE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn is_fresh(info: &SystemInfo, at: std::time::Instant, empty_retries: u32) -> bool {
    // macOS has no NVML/Vulkan path here, so an empty list is final.
    !info.gpus.is_empty()
        || cfg!(target_os = "macos")
        || empty_retries >= MAX_EMPTY_GPU_RETRIES
        || at.elapsed() < EMPTY_GPU_RETRY
}

fn cached_system_info() -> Option<SystemInfo> {
    let guard = SYSTEM_INFO.read().unwrap_or_else(|e| e.into_inner());
    let retries = EMPTY_GPU_RETRIES.load(std::sync::atomic::Ordering::Relaxed);
    match guard.as_ref() {
        Some((info, at)) if is_fresh(info, *at, retries) => Some(info.clone()),
        _ => None,
    }
}

/// Compute system hardware information (CPU, memory, GPUs).
///
/// Results are cached after the first call; subsequent calls return the cached
/// value. Use `invalidate_system_info()` to force re-detection.
pub fn get_system_info() -> SystemInfo {
    if let Some(info) = cached_system_info() {
        return info;
    }
    let _compute = COMPUTE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Another caller may have refreshed the cache while this one waited.
    if let Some(info) = cached_system_info() {
        return info;
    }
    let had_snapshot = SYSTEM_INFO
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    let info = compute_system_info();
    if info.gpus.is_empty() {
        if had_snapshot {
            EMPTY_GPU_RETRIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    } else {
        EMPTY_GPU_RETRIES.store(0, std::sync::atomic::Ordering::Relaxed);
    }
    {
        let mut guard = SYSTEM_INFO.write().unwrap_or_else(|e| e.into_inner());
        *guard = Some((info.clone(), std::time::Instant::now()));
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
        available_memory: system.available_memory() / 1024 / 1024,
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
    EMPTY_GPU_RETRIES.store(0, std::sync::atomic::Ordering::Relaxed);
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

    let default_active_gpus = default_active_gpus(&gpus);
    SystemInfo {
        cpu: CpuStaticInfo::new(),
        os_type: os_type.to_string(),
        os_name,
        total_memory: system.total_memory() / 1024 / 1024,
        gpus,
        default_active_gpus,
    }
}

/// Which GPUs to use by default: discrete cards when any exists (an integrated
/// GPU shares system RAM and a virtual one is a hypervisor shim), and only
/// NVIDIA's when an NVIDIA card is present. With no discrete card everything
/// is active.
pub fn default_active_gpus(gpus: &[GpuInfo]) -> Vec<String> {
    let is_discrete = |g: &GpuInfo| {
        g.nvidia_info.is_some()
            || g.vulkan_info
                .as_ref()
                .is_some_and(|v| v.device_type == "DiscreteGpu")
    };
    let discrete: Vec<&GpuInfo> = gpus.iter().filter(|g| is_discrete(g)).collect();
    if discrete.is_empty() {
        return gpus.iter().map(|g| g.uuid.clone()).collect();
    }
    let any_nvidia = discrete
        .iter()
        .any(|g| matches!(g.vendor, Vendor::NVIDIA));
    discrete
        .into_iter()
        .filter(|g| !any_nvidia || matches!(g.vendor, Vendor::NVIDIA))
        .map(|g| g.uuid.clone())
        .collect()
}

#[cfg(test)]
mod default_active_tests {
    use super::*;
    use crate::vendor::vulkan::VulkanInfo;

    fn gpu(uuid: &str, vendor: Vendor, device_type: &str) -> GpuInfo {
        GpuInfo {
            name: uuid.to_string(),
            total_memory: 8192,
            vendor,
            uuid: uuid.to_string(),
            driver_version: String::new(),
            nvidia_info: None,
            vulkan_info: Some(VulkanInfo {
                index: 0,
                device_type: device_type.to_string(),
                api_version: "1.3.0".to_string(),
                device_id: 0,
            }),
        }
    }

    #[test]
    fn integrated_is_left_out_when_a_discrete_card_exists() {
        let gpus = vec![
            gpu("igpu", Vendor::Intel, "IntegratedGpu"),
            gpu("dgpu", Vendor::AMD, "DiscreteGpu"),
        ];
        assert_eq!(default_active_gpus(&gpus), vec!["dgpu".to_string()]);
    }

    #[test]
    fn nvidia_wins_over_other_discrete_cards() {
        let gpus = vec![
            gpu("amd", Vendor::AMD, "DiscreteGpu"),
            gpu("nv", Vendor::NVIDIA, "DiscreteGpu"),
        ];
        assert_eq!(default_active_gpus(&gpus), vec!["nv".to_string()]);
    }

    #[test]
    fn a_lone_integrated_gpu_stays_active() {
        let gpus = vec![gpu("igpu", Vendor::Intel, "IntegratedGpu")];
        assert_eq!(default_active_gpus(&gpus), vec!["igpu".to_string()]);
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
