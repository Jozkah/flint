use crate::types::{SystemInfo, SystemUsage};
use sysinfo::System;

#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    crate::get_system_info()
}

#[tauri::command]
pub fn refresh_system_info() {
    crate::invalidate_system_info();
}

#[tauri::command]
pub fn get_system_usage() -> SystemUsage {
    let mut system = System::new();
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
