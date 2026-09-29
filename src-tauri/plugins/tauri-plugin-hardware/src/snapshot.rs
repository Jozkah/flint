//! Detailed, poll-friendly system snapshot for the System Monitor page.
//!
//! The sysinfo collectors live in one process-wide state so that successive
//! polls reuse them: CPU usage is measured between two refreshes (no sleep
//! needed after the first poll), and each poll refreshes only the kinds the
//! page shows (CPU usage and frequency, memory and swap, disks, network
//! counters, sensors). Network rates are derived by the caller from the
//! cumulative totals of two snapshots.

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{
    Components, CpuRefreshKind, DiskRefreshKind, Disks, MemoryRefreshKind, Networks, RefreshKind,
    System,
};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CpuDetails {
    pub name: String,
    /// Average frequency across logical cores, in MHz.
    pub frequency_mhz: u64,
    pub physical_cores: Option<usize>,
    pub logical_cores: usize,
    /// Overall usage, percent.
    pub usage: f32,
    /// Usage per logical core, percent.
    pub per_core: Vec<f32>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MemoryDetails {
    pub total: u64,
    pub used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DiskDetails {
    pub name: String,
    pub mount_point: String,
    pub file_system: String,
    /// "SSD", "HDD" or "Unknown".
    pub kind: String,
    pub total: u64,
    pub available: u64,
    pub removable: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NetworkDetails {
    pub name: String,
    pub mac_address: String,
    /// Cumulative bytes since boot (or since the adapter came up).
    pub total_received: u64,
    pub total_transmitted: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SensorDetails {
    pub label: String,
    /// "cpu", "gpu", "disk" or "other".
    pub kind: String,
    /// Where the reading came from, e.g. "sysinfo", "NVML" or a Windows
    /// WMI class; shown so users can tell zones from real CPU sensors.
    pub source: String,
    pub temperature: Option<f32>,
    pub max: Option<f32>,
    pub critical: Option<f32>,
}

/// All sizes in bytes, temperatures in Celsius.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SystemSnapshot {
    pub host_name: Option<String>,
    pub os_version: Option<String>,
    pub kernel_version: Option<String>,
    pub uptime_secs: u64,
    /// Milliseconds since the Unix epoch when the snapshot was taken, for
    /// rate computation on the caller's side.
    pub timestamp_ms: u64,
    pub cpu: CpuDetails,
    pub memory: MemoryDetails,
    pub disks: Vec<DiskDetails>,
    pub networks: Vec<NetworkDetails>,
    pub sensors: Vec<SensorDetails>,
}

struct Collectors {
    system: System,
    networks: Networks,
    components: Components,
}

static COLLECTORS: Mutex<Option<Collectors>> = Mutex::new(None);

fn sensor_kind(label: &str) -> &'static str {
    let l = label.to_ascii_lowercase();
    if l.contains("gpu") || l.contains("amdgpu") || l.contains("nouveau") {
        "gpu"
    } else if l.contains("nvme")
        || l.contains("ssd")
        || l.contains("disk")
        || l.contains("drive")
        || l.contains("drivetemp")
    {
        "disk"
    } else if l.contains("cpu")
        || l.contains("core")
        || l.contains("package")
        || l.contains("tctl")
        || l.contains("tdie")
        || l.contains("k10temp")
        || l.contains("coretemp")
        || l.contains("acpi")
        || l.contains("thermal zone")
    {
        "cpu"
    } else {
        "other"
    }
}

/// Apple Silicon publishes every raw PMU thermal point (`PMU tdie0..10`,
/// `PMU tdev1..8`, `PMU TP0s..TP3g`, ...) as its own component: ~30 rows that
/// all read within a degree of each other and mean nothing individually. This
/// folds them into the handful a user can act on -- CPU die, SoC, SSD, battery
/// -- reporting the hottest point of each group. `tcal` is a calibration
/// reference, not a temperature anyone wants, and is dropped.
///
/// Only labels in the PMU family are folded; anything else (an Intel Mac's
/// named sensors, an external reading) passes through untouched.
#[cfg(any(target_os = "macos", test))]
fn condense_apple_sensors(raw: Vec<SensorDetails>) -> Vec<SensorDetails> {
    if !raw.iter().any(|s| s.label.starts_with("PMU ")) {
        return raw;
    }
    // Insertion-ordered so the page lists CPU first, then whatever follows.
    let mut groups: Vec<(String, String, Vec<SensorDetails>)> = Vec::new();
    let mut passthrough = Vec::new();
    for sensor in raw {
        let l = sensor.label.to_ascii_lowercase();
        let target: Option<(&str, &str)> = if l.contains("tdie") {
            Some(("CPU", "cpu"))
        } else if l.starts_with("nand") {
            Some(("SSD", "disk"))
        } else if l.contains("battery") {
            Some(("Battery", "other"))
        } else if l.contains("tcal") {
            None
        } else if l.starts_with("pmu ") {
            Some(("SoC", "other"))
        } else {
            passthrough.push(sensor);
            continue;
        };
        let Some((label, kind)) = target else { continue };
        match groups.iter_mut().find(|(g, _, _)| g == label) {
            Some((_, _, members)) => members.push(sensor),
            None => groups.push((label.to_string(), kind.to_string(), vec![sensor])),
        }
    }
    let hottest = |vals: Vec<Option<f32>>| vals.into_iter().flatten().reduce(f32::max);
    let order = ["CPU", "SoC", "SSD", "Battery"];
    groups.sort_by_key(|(g, _, _)| order.iter().position(|o| o == g).unwrap_or(order.len()));
    let mut out: Vec<SensorDetails> = groups
        .into_iter()
        .map(|(label, kind, members)| SensorDetails {
            temperature: hottest(members.iter().map(|m| m.temperature).collect()),
            max: hottest(members.iter().map(|m| m.max).collect()),
            critical: hottest(members.iter().map(|m| m.critical).collect()),
            source: if members.len() == 1 {
                "sysinfo".into()
            } else {
                format!("hottest of {} sensors", members.len())
            },
            label,
            kind,
        })
        .collect();
    out.extend(passthrough);
    out
}

/// macOS mounts the system APFS container several times over: `/` and
/// `/System/Volumes/Data` are one volume group with one free-space figure, and
/// `/System/Volumes/{VM,Preboot,Update,xarts,...}` are internal volumes the
/// user never touches. Show the container once, at `/`, plus anything under
/// `/Volumes` (external and secondary drives).
#[cfg(any(target_os = "macos", test))]
fn hide_apple_system_volumes(disks: Vec<DiskDetails>) -> Vec<DiskDetails> {
    disks
        .into_iter()
        .filter(|d| !d.mount_point.starts_with("/System/Volumes/"))
        .filter(|d| !d.mount_point.starts_with("/private/var/vm"))
        .collect()
}

/// Collect a snapshot, refreshing only what the page needs.
pub fn get_system_snapshot() -> SystemSnapshot {
    let mut guard = COLLECTORS.lock().unwrap_or_else(|e| e.into_inner());
    let first = guard.is_none();
    let c = guard.get_or_insert_with(|| Collectors {
        system: System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage().with_frequency())
                .with_memory(MemoryRefreshKind::everything()),
        ),
        networks: Networks::new_with_refreshed_list(),
        // On Windows sysinfo reads only the ACPI zones, which the cached
        // query in `windows_sensors` covers along with more sources.
        components: if cfg!(windows) {
            Components::new()
        } else {
            Components::new_with_refreshed_list()
        },
    });

    let cpu_kind = CpuRefreshKind::nothing().with_cpu_usage().with_frequency();
    if first {
        // Usage needs two samples; only the very first poll pays the wait.
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        c.system.refresh_cpu_specifics(cpu_kind);
    } else {
        c.system.refresh_cpu_specifics(cpu_kind);
        c.networks.refresh(true);
        if !cfg!(windows) {
            c.components.refresh(true);
        }
    }
    c.system
        .refresh_memory_specifics(MemoryRefreshKind::everything());

    let cpus = c.system.cpus();
    let per_core: Vec<f32> = cpus.iter().map(|cpu| cpu.cpu_usage()).collect();
    let logical = cpus.len();
    let usage = per_core.iter().sum::<f32>() / (logical.max(1) as f32);
    let frequency_mhz = if logical == 0 {
        0
    } else {
        cpus.iter().map(|cpu| cpu.frequency()).sum::<u64>() / logical as u64
    };
    let name = cpus
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .unwrap_or_default();

    let disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_storage())
        .list()
        .iter()
        .map(|d| DiskDetails {
            name: d.name().to_string_lossy().into_owned(),
            mount_point: d.mount_point().to_string_lossy().into_owned(),
            file_system: d.file_system().to_string_lossy().into_owned(),
            kind: match d.kind() {
                sysinfo::DiskKind::SSD => "SSD".into(),
                sysinfo::DiskKind::HDD => "HDD".into(),
                _ => "Unknown".into(),
            },
            total: d.total_space(),
            available: d.available_space(),
            removable: d.is_removable(),
        })
        .collect();
    #[cfg(target_os = "macos")]
    let disks = hide_apple_system_volumes(disks);

    let mut networks: Vec<NetworkDetails> = c
        .networks
        .iter()
        .map(|(name, data)| NetworkDetails {
            name: name.clone(),
            mac_address: data.mac_address().to_string(),
            total_received: data.total_received(),
            total_transmitted: data.total_transmitted(),
        })
        .collect();
    networks.sort_by(|a, b| a.name.cmp(&b.name));

    let mut sensors: Vec<SensorDetails> = c
        .components
        .iter()
        .map(|comp| SensorDetails {
            label: comp.label().to_string(),
            kind: sensor_kind(comp.label()).into(),
            source: "sysinfo".into(),
            temperature: comp.temperature().filter(|t| t.is_finite()),
            max: comp.max().filter(|t| t.is_finite()),
            critical: comp.critical().filter(|t| t.is_finite()),
        })
        .collect();
    #[cfg(target_os = "macos")]
    let mut sensors = condense_apple_sensors(sensors);
    sensors.extend(crate::windows_sensors::sensors());
    for gpu in crate::get_system_info().gpus {
        if let Some((temp, critical)) = gpu.nvidia_temperature() {
            sensors.push(SensorDetails {
                label: gpu.name.clone(),
                kind: "gpu".into(),
                source: "NVML".into(),
                temperature: Some(temp),
                max: None,
                critical,
            });
        }
    }

    let memory = MemoryDetails {
        total: c.system.total_memory(),
        used: c.system.used_memory(),
        swap_total: c.system.total_swap(),
        swap_used: c.system.used_swap(),
    };

    SystemSnapshot {
        host_name: System::host_name(),
        os_version: System::long_os_version(),
        kernel_version: System::kernel_version(),
        uptime_secs: System::uptime(),
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        cpu: CpuDetails {
            name,
            frequency_mhz,
            physical_cores: System::physical_core_count(),
            logical_cores: logical,
            usage,
            per_core,
        },
        memory,
        disks,
        networks,
        sensors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_has_expected_shape() {
        let snap = get_system_snapshot();
        assert!(snap.cpu.logical_cores > 0);
        assert_eq!(snap.cpu.per_core.len(), snap.cpu.logical_cores);
        assert!(snap.cpu.per_core.iter().all(|u| u.is_finite()));
        assert!(snap.memory.total > 0);
        assert!(snap.memory.used <= snap.memory.total);
        assert!(snap.timestamp_ms > 0);
        for d in &snap.disks {
            assert!(d.available <= d.total);
        }

        let json = serde_json::to_value(&snap).unwrap();
        for key in [
            "host_name",
            "os_version",
            "kernel_version",
            "uptime_secs",
            "timestamp_ms",
            "cpu",
            "memory",
            "disks",
            "networks",
            "sensors",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        for key in [
            "name",
            "frequency_mhz",
            "physical_cores",
            "logical_cores",
            "usage",
            "per_core",
        ] {
            assert!(json["cpu"].get(key).is_some(), "missing cpu.{key}");
        }
        for key in ["total", "used", "swap_total", "swap_used"] {
            assert!(json["memory"].get(key).is_some(), "missing memory.{key}");
        }

        // A second poll reuses the collectors and keeps the counters monotonic.
        let again = get_system_snapshot();
        for n in &again.networks {
            if let Some(prev) = snap.networks.iter().find(|p| p.name == n.name) {
                assert!(n.total_received >= prev.total_received);
            }
        }
    }

    #[test]
    fn apple_pmu_sensors_fold_into_groups() {
        let mk = |label: &str, t: f32| SensorDetails {
            label: label.into(),
            kind: sensor_kind(label).into(),
            source: "sysinfo".into(),
            temperature: Some(t),
            max: Some(t + 1.0),
            critical: None,
        };
        let raw = vec![
            mk("PMU tdev1", 36.0),
            mk("PMU tdie1", 40.2),
            mk("gas gauge battery", 30.0),
            mk("PMU tdie3", 41.5),
            mk("NAND CH0 temp", 31.0),
            mk("PMU tcal", 51.8),
            mk("PMU TP1g", 40.4),
            mk("External probe", 22.0),
        ];
        let out = condense_apple_sensors(raw);
        let labels: Vec<&str> = out.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(labels, ["CPU", "SoC", "SSD", "Battery", "External probe"]);
        let cpu = &out[0];
        assert_eq!(cpu.kind, "cpu");
        assert_eq!(cpu.temperature, Some(41.5));
        assert_eq!(cpu.max, Some(42.5));
        assert_eq!(cpu.source, "hottest of 2 sensors");
        assert_eq!(out[2].kind, "disk");
        assert_eq!(out[2].source, "sysinfo");
        assert!(out.iter().all(|s| !s.label.contains("tcal")));
    }

    #[test]
    fn non_pmu_sensors_pass_through_unchanged() {
        let raw = vec![SensorDetails {
            label: "coretemp Package id 0".into(),
            kind: "cpu".into(),
            source: "sysinfo".into(),
            temperature: Some(50.0),
            max: None,
            critical: None,
        }];
        assert_eq!(condense_apple_sensors(raw.clone()), raw);
    }

    #[test]
    fn apple_system_volumes_are_hidden() {
        let mk = |mount: &str| DiskDetails {
            name: "Macintosh HD".into(),
            mount_point: mount.into(),
            file_system: "apfs".into(),
            kind: "Unknown".into(),
            total: 10,
            available: 5,
            removable: false,
        };
        let out = hide_apple_system_volumes(vec![
            mk("/"),
            mk("/System/Volumes/Data"),
            mk("/System/Volumes/VM"),
            mk("/Volumes/Backup"),
        ]);
        let mounts: Vec<&str> = out.iter().map(|d| d.mount_point.as_str()).collect();
        assert_eq!(mounts, ["/", "/Volumes/Backup"]);
    }

    #[test]
    fn sensor_kind_classifies_common_labels() {
        assert_eq!(sensor_kind("coretemp Package id 0"), "cpu");
        assert_eq!(sensor_kind("k10temp Tctl"), "cpu");
        assert_eq!(sensor_kind("nvme Composite"), "disk");
        assert_eq!(sensor_kind("amdgpu edge"), "gpu");
        assert_eq!(sensor_kind("acpitz temp1"), "cpu");
        assert_eq!(sensor_kind("iwlwifi_1"), "other");
    }
}
