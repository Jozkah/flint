//! Windows temperature sources that sysinfo does not cover without admin.
//!
//! One PowerShell/CIM query reads three sources:
//! - `root\WMI MSAcpi_ThermalZoneTemperature` (ACPI thermal zones; usually
//!   needs admin, tried anyway),
//! - `root\cimv2 Win32_PerfFormattedData_Counters_ThermalZoneInformation`
//!   (thermal zone performance counters; readable unelevated on many
//!   machines),
//! - `Get-StorageReliabilityCounter` (`MSFT_StorageReliabilityCounter`,
//!   drive temperatures; also usually admin-only),
//! - `root\LibreHardwareMonitor` / `root\OpenHardwareMonitor` `Sensor`,
//!   published by those tools while they run; readable unelevated and the
//!   only reliable way to get per-core CPU temperatures without admin.
//!
//! Spawning PowerShell costs about a second, so the query runs on a
//! background thread at most every 30 seconds and polls return the cached
//! result immediately.

use crate::snapshot::SensorDetails;
use serde_json::Value;

pub const SOURCE_ACPI: &str = "ACPI thermal zone (WMI)";
pub const SOURCE_PERF: &str = "Thermal zone counter";
pub const SOURCE_STORAGE: &str = "Storage reliability counter";
pub const SOURCE_LHM: &str = "LibreHardwareMonitor";
pub const SOURCE_OHM: &str = "OpenHardwareMonitor";

const KELVIN: f32 = 273.15;

/// The PowerShell script; each source fails independently.
#[cfg(windows)]
const SCRIPT: &str = r#"$ErrorActionPreference='SilentlyContinue'
$o=[ordered]@{}
try { $o.acpi = @(Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object InstanceName,CurrentTemperature,CriticalTripPoint) } catch {}
try { $o.perf = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop | Select-Object Name,Temperature,HighPrecisionTemperature) } catch {}
try { $o.disks = @(Get-PhysicalDisk -ErrorAction Stop | ForEach-Object { $r = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue; [pscustomobject]@{ Name = $_.FriendlyName; Temperature = $r.Temperature; TemperatureMax = $r.TemperatureMax } }) } catch {}
foreach ($ns in 'LibreHardwareMonitor','OpenHardwareMonitor') { try { $o[$ns] = @(Get-CimInstance -Namespace "root/$ns" -ClassName Sensor -Filter "SensorType='Temperature'" -ErrorAction Stop | Select-Object Name,Parent,Value,Max) } catch {} }
$o | ConvertTo-Json -Depth 4 -Compress"#;

fn as_list(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(other) => vec![other],
    }
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn plausible(c: f32) -> Option<f32> {
    (c.is_finite() && c > -40.0 && c < 150.0).then_some(c)
}

fn zone_name(raw: &str) -> String {
    // "\_TZ.CPUZ" or "ACPI\ThermalZone\TZ00_0" -> the last path segment.
    raw.rsplit(['\\', '.'])
        .find(|s| !s.is_empty())
        .unwrap_or(raw)
        .to_string()
}

/// Parse the script's JSON output into sensors.
pub fn parse_output(json: &str) -> Vec<SensorDetails> {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let mut sensors = Vec::new();

    // ACPI: tenths of Kelvin.
    for z in as_list(root.get("acpi")) {
        let Some(t) =
            num(z, "CurrentTemperature").and_then(|t| plausible(t as f32 / 10.0 - KELVIN))
        else {
            continue;
        };
        let name = z
            .get("InstanceName")
            .and_then(Value::as_str)
            .unwrap_or("Zone");
        sensors.push(SensorDetails {
            label: format!("Thermal zone {}", zone_name(name)),
            kind: "cpu".into(),
            source: SOURCE_ACPI.into(),
            temperature: Some(t),
            max: None,
            critical: num(z, "CriticalTripPoint").and_then(|c| plausible(c as f32 / 10.0 - KELVIN)),
        });
    }

    // Performance counters describe the same zones; use them only when
    // ACPI was not readable. Temperature is Kelvin, HighPrecision tenths.
    if sensors.is_empty() {
        for z in as_list(root.get("perf")) {
            let kelvin = num(z, "HighPrecisionTemperature")
                .filter(|t| *t > 0.0)
                .map(|t| t / 10.0)
                .or_else(|| num(z, "Temperature"));
            let Some(t) = kelvin.and_then(|k| plausible(k as f32 - KELVIN)) else {
                continue;
            };
            let name = z.get("Name").and_then(Value::as_str).unwrap_or("Zone");
            sensors.push(SensorDetails {
                label: format!("Thermal zone {}", zone_name(name)),
                kind: "cpu".into(),
                source: SOURCE_PERF.into(),
                temperature: Some(t),
                max: None,
                critical: None,
            });
        }
    }

    // Storage reliability: Celsius.
    for d in as_list(root.get("disks")) {
        let Some(t) = num(d, "Temperature")
            .filter(|t| *t > 0.0)
            .and_then(|t| plausible(t as f32))
        else {
            continue;
        };
        sensors.push(SensorDetails {
            label: d
                .get("Name")
                .and_then(Value::as_str)
                .unwrap_or("Drive")
                .to_string(),
            kind: "disk".into(),
            source: SOURCE_STORAGE.into(),
            temperature: Some(t),
            max: None,
            critical: num(d, "TemperatureMax")
                .filter(|t| *t > 0.0)
                .and_then(|t| plausible(t as f32)),
        });
    }

    // Hardware monitor tools: Celsius, parent identifies the device
    // ("/intelcpu/0", "/nvme/1", "/gpu-nvidia/0").
    for (key, source) in [
        ("LibreHardwareMonitor", SOURCE_LHM),
        ("OpenHardwareMonitor", SOURCE_OHM),
    ] {
        for v in as_list(root.get(key)) {
            let Some(t) = num(v, "Value").and_then(|t| plausible(t as f32)) else {
                continue;
            };
            let parent = v
                .get("Parent")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let kind = if parent.contains("cpu") {
                "cpu"
            } else if parent.contains("gpu") {
                "gpu"
            } else if parent.contains("nvme") || parent.contains("hdd") || parent.contains("ssd") {
                "disk"
            } else {
                "other"
            };
            sensors.push(SensorDetails {
                label: v
                    .get("Name")
                    .and_then(Value::as_str)
                    .unwrap_or("Sensor")
                    .to_string(),
                kind: kind.into(),
                source: source.into(),
                temperature: Some(t),
                max: num(v, "Max").and_then(|m| plausible(m as f32)),
                critical: None,
            });
        }
    }
    sensors
}

#[cfg(windows)]
mod cache {
    use super::*;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    const TTL: Duration = Duration::from_secs(30);

    struct State {
        fetched: Option<Instant>,
        running: bool,
        sensors: Vec<SensorDetails>,
    }

    static STATE: Mutex<State> = Mutex::new(State {
        fetched: None,
        running: false,
        sensors: Vec::new(),
    });

    fn query() -> Vec<SensorDetails> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match out {
            Ok(o) => parse_output(&String::from_utf8_lossy(&o.stdout)),
            Err(e) => {
                log::warn!("Temperature query failed: {e}");
                Vec::new()
            }
        }
    }

    /// Cached sensors; starts a background refresh when stale.
    pub fn sensors() -> Vec<SensorDetails> {
        let mut s = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let stale = s.fetched.map_or(true, |t| t.elapsed() >= TTL);
        if stale && !s.running {
            s.running = true;
            std::thread::spawn(|| {
                let sensors = query();
                let mut s = STATE.lock().unwrap_or_else(|e| e.into_inner());
                s.sensors = sensors;
                s.fetched = Some(Instant::now());
                s.running = false;
            });
        }
        s.sensors.clone()
    }
}

#[cfg(windows)]
pub use cache::sensors;

#[cfg(not(windows))]
pub fn sensors() -> Vec<SensorDetails> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_acpi_in_tenths_of_kelvin() {
        let json = r#"{"acpi":{"InstanceName":"ACPI\\ThermalZone\\TZ00_0","CurrentTemperature":3232,"CriticalTripPoint":3782},"perf":[{"Name":"\\_TZ.TZ00","Temperature":320,"HighPrecisionTemperature":3200}]}"#;
        let s = parse_output(json);
        assert_eq!(s.len(), 1, "perf zones are skipped when ACPI is readable");
        assert_eq!(s[0].label, "Thermal zone TZ00_0");
        assert_eq!(s[0].source, SOURCE_ACPI);
        assert!((s[0].temperature.unwrap() - 50.05).abs() < 0.01);
        assert!((s[0].critical.unwrap() - 105.05).abs() < 0.01);
    }

    #[test]
    fn falls_back_to_perf_counters_in_kelvin() {
        let json = r#"{"perf":[{"Name":"\\_TZ.CPUZ","Temperature":321,"HighPrecisionTemperature":0},{"Name":"\\_TZ.GFXZ","Temperature":0,"HighPrecisionTemperature":3131}]}"#;
        let s = parse_output(json);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].label, "Thermal zone CPUZ");
        assert_eq!(s[0].source, SOURCE_PERF);
        assert!((s[0].temperature.unwrap() - 47.85).abs() < 0.01);
        assert!((s[1].temperature.unwrap() - 39.95).abs() < 0.01);
    }

    #[test]
    fn parses_drive_temperatures_and_skips_zero() {
        let json = r#"{"disks":[{"Name":"Samsung SSD 990 PRO","Temperature":41,"TemperatureMax":82},{"Name":"USB Stick","Temperature":0,"TemperatureMax":0}]}"#;
        let s = parse_output(json);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].kind, "disk");
        assert_eq!(s[0].source, SOURCE_STORAGE);
        assert_eq!(s[0].temperature, Some(41.0));
        assert_eq!(s[0].critical, Some(82.0));
    }

    #[test]
    fn parses_hardware_monitor_sensors() {
        let json = r#"{"LibreHardwareMonitor":[{"Name":"CPU Package","Parent":"/amdcpu/0","Value":55.5,"Max":71.0},{"Name":"Temperature","Parent":"/nvme/0","Value":38,"Max":44}]}"#;
        let s = parse_output(json);
        assert_eq!(s.len(), 2);
        assert_eq!(
            (s[0].kind.as_str(), s[0].source.as_str()),
            ("cpu", SOURCE_LHM)
        );
        assert_eq!(s[0].max, Some(71.0));
        assert_eq!(s[1].kind, "disk");
    }

    #[test]
    fn tolerates_garbage() {
        assert!(parse_output("").is_empty());
        assert!(parse_output("{}").is_empty());
        assert!(parse_output(r#"{"acpi":null,"disks":[{"Name":"x"}]}"#).is_empty());
    }
}
