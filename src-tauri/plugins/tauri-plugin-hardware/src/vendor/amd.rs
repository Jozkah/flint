use crate::types::{GpuInfo, GpuUsage};
use crate::vendor::vulkan::PciBusInfo;

/// Parses `PCI_SLOT_NAME=0000:03:00.0` out of a sysfs `uevent` file.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_pci_slot_name(uevent: &str) -> Option<PciBusInfo> {
    let slot = uevent
        .lines()
        .find_map(|l| l.trim().strip_prefix("PCI_SLOT_NAME="))?
        .trim();
    // domain:bus:device.function, all hex
    let mut parts = slot.split(':');
    let domain = u32::from_str_radix(parts.next()?, 16).ok()?;
    let bus = u32::from_str_radix(parts.next()?, 16).ok()?;
    let rest = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (device, function) = rest.split_once('.')?;
    Some(PciBusInfo {
        domain,
        bus,
        device: u32::from_str_radix(device, 16).ok()?,
        function: u32::from_str_radix(function, 16).ok()?,
    })
}

/// One distinct amdgpu card found in sysfs.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SysfsCandidate {
    slot: Option<PciBusInfo>,
    device_id: Option<u32>,
}

/// Picks the sysfs card for a Vulkan device. Exact PCI address wins. Without
/// Vulkan bus info the device id is used only when exactly one card carries
/// it; identical cards would otherwise all read the first card's usage.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn select_sysfs_candidate(
    bus: Option<PciBusInfo>,
    device_id: u32,
    candidates: &[SysfsCandidate],
) -> Option<usize> {
    if let Some(bus) = bus {
        return candidates.iter().position(|c| c.slot == Some(bus));
    }
    let mut matches = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| c.device_id == Some(device_id));
    match (matches.next(), matches.next()) {
        (Some((i, _)), None) => Some(i),
        _ => None,
    }
}

/// One active ADL adapter with its VRAM usage. `used_mb` is None when the
/// ADL usage call failed.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct AdlUsage {
    bus: u32,
    device: u32,
    function: u32,
    name: String,
    used_mb: Option<u64>,
}

/// Finds the ADL adapter for a GPU and returns its used MiB. None means
/// unknown: no match, an ambiguous name, or a failed ADL call.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn pick_adl_usage(entries: &[AdlUsage], bus: Option<PciBusInfo>, name: &str) -> Option<u64> {
    let entry = match bus {
        Some(b) => entries
            .iter()
            .find(|e| e.bus == b.bus && e.device == b.device && e.function == b.function)?,
        None => {
            let mut by_name = entries.iter().filter(|e| e.name == name);
            match (by_name.next(), by_name.next()) {
                (Some(e), None) => e,
                _ => return None,
            }
        }
    };
    entry.used_mb
}

impl GpuInfo {
    #[cfg(not(target_os = "linux"))]
    #[cfg(not(target_os = "windows"))]
    pub fn get_usage_amd(&self) -> GpuUsage {
        self.get_usage_unsupported()
    }

    #[cfg(target_os = "linux")]
    pub fn get_usage_amd(&self) -> GpuUsage {
        use std::collections::HashSet;
        use std::fs;
        use std::path::{Path, PathBuf};

        let (device_id, bus) = match &self.vulkan_info {
            Some(v) => (v.device_id, v.pci_bus_info),
            None => {
                log::error!("get_usage_amd called without Vulkan info");
                return self.get_usage_unsupported();
            }
        };

        // Collect distinct amdgpu cards, skipping any entry that cannot be
        // read. card0, renderD128 and connector nodes share one device dir.
        let mut seen = HashSet::new();
        let mut paths: Vec<PathBuf> = Vec::new();
        let mut candidates: Vec<SysfsCandidate> = Vec::new();
        let entries = match fs::read_dir("/sys/class/drm") {
            Ok(e) => e,
            Err(e) => {
                log::error!("Failed to read /sys/class/drm: {e}");
                return self.get_usage_unsupported();
            }
        };
        for entry in entries.flatten() {
            let device_path = entry.path().join("device");
            if !device_path
                .join("driver/module/drivers/pci:amdgpu")
                .exists()
            {
                continue;
            }
            let real = fs::canonicalize(&device_path).unwrap_or_else(|_| device_path.clone());
            if !seen.insert(real) {
                continue;
            }
            let slot = fs::read_to_string(device_path.join("uevent"))
                .ok()
                .and_then(|u| parse_pci_slot_name(&u));
            let dev_id = fs::read_to_string(device_path.join("device"))
                .ok()
                .and_then(|s| {
                    let s = s.trim();
                    u32::from_str_radix(s.strip_prefix("0x").unwrap_or(s), 16).ok()
                });
            paths.push(device_path);
            candidates.push(SysfsCandidate {
                slot,
                device_id: dev_id,
            });
        }

        let Some(idx) = select_sysfs_candidate(bus, device_id, &candidates) else {
            log::warn!(
                "AMD GPU {:#x}: no unambiguous sysfs match, usage unknown",
                device_id
            );
            return self.get_usage_unsupported();
        };

        let read_mem = |path: &Path| -> Option<u64> {
            let bytes = fs::read_to_string(path).ok()?.trim().parse::<u64>().ok()?;
            Some(bytes / 1024 / 1024) // bytes to MiB
        };
        let dir = &paths[idx];
        match (
            read_mem(&dir.join("mem_info_vram_total")),
            read_mem(&dir.join("mem_info_vram_used")),
        ) {
            (Some(total_memory), Some(used_memory)) => GpuUsage {
                uuid: self.uuid.clone(),
                total_memory,
                used_memory,
            },
            _ => {
                log::error!("Failed to read VRAM counters for AMD GPU {:#x}", device_id);
                self.get_usage_unsupported()
            }
        }
    }

    #[cfg(target_os = "windows")]
    pub fn get_usage_amd(&self) -> GpuUsage {
        let entries = match windows_impl::get_gpu_usage() {
            Ok(e) => e,
            Err(e) => {
                log::error!("Failed to get AMD GPU memory usage: {e}");
                return self.get_usage_unsupported();
            }
        };
        let bus = self.vulkan_info.as_ref().and_then(|v| v.pci_bus_info);
        match pick_adl_usage(&entries, bus, &self.name) {
            Some(used_memory) => GpuUsage {
                uuid: self.uuid.clone(),
                used_memory,
                total_memory: self.total_memory,
            },
            None => self.get_usage_unsupported(),
        }
    }
}

// TODO: refactor this into a more egonomic API
#[cfg(target_os = "windows")]
mod windows_impl {
    use super::AdlUsage;
    use libc;
    use libloading::{Library, Symbol};
    use std::ffi::{c_char, c_int, c_void, CStr};
    use std::mem::{self, MaybeUninit};
    use std::ptr;

    // === FFI Struct Definitions ===
    #[repr(C)]
    #[allow(non_snake_case)]
    #[derive(Debug, Copy, Clone)]
    pub struct AdapterInfo {
        pub iSize: c_int,
        pub iAdapterIndex: c_int,
        pub strUDID: [c_char; 256],
        pub iBusNumber: c_int,
        pub iDeviceNumber: c_int,
        pub iFunctionNumber: c_int,
        pub iVendorID: c_int,
        pub strAdapterName: [c_char; 256],
        pub strDisplayName: [c_char; 256],
        pub iPresent: c_int,
        pub iExist: c_int,
        pub strDriverPath: [c_char; 256],
        pub strDriverPathExt: [c_char; 256],
        pub strPNPString: [c_char; 256],
        pub iOSDisplayIndex: c_int,
    }

    type AdlMainMallocCallback = Option<unsafe extern "C" fn(i32) -> *mut c_void>;
    type AdlMainControlCreate = unsafe extern "C" fn(AdlMainMallocCallback, c_int) -> c_int;
    type AdlMainControlDestroy = unsafe extern "C" fn() -> c_int;
    type AdlAdapterNumberofadaptersGet = unsafe extern "C" fn(*mut c_int) -> c_int;
    type AdlAdapterAdapterinfoGet = unsafe extern "C" fn(*mut AdapterInfo, c_int) -> c_int;
    type AdlAdapterActiveGet = unsafe extern "C" fn(c_int, *mut c_int) -> c_int;
    type Adl2MainControlCreate =
        unsafe extern "C" fn(AdlMainMallocCallback, c_int, *mut *mut c_void) -> c_int;
    type Adl2MainControlDestroy = unsafe extern "C" fn(*mut c_void) -> c_int;
    type AdlGetDedicatedVramUsage =
        unsafe extern "C" fn(*mut c_void, c_int, *mut c_int) -> c_int;

    // === ADL Memory Allocator ===
    unsafe extern "C" fn adl_malloc(i_size: i32) -> *mut c_void {
        libc::malloc(i_size as usize)
    }

    pub fn get_gpu_usage() -> Result<Vec<AdlUsage>, Box<dyn std::error::Error>> {
        unsafe {
            let lib = Library::new("atiadlxx.dll").or_else(|_| Library::new("atiadlxy.dll"))?;

            macro_rules! get_sym {
                ($lib:expr, $name:literal, $ty:ty) => {{
                    $lib.get::<$ty>($name).map_err(|e| {
                        log::error!(
                            "Failed to resolve AMD ADL symbol '{}': {e}",
                            std::str::from_utf8($name).unwrap_or("?")
                        );
                        e
                    })?
                }};
            }

            let adlmaincontrolcreate: Symbol<AdlMainControlCreate> =
                get_sym!(lib, b"ADL_Main_Control_Create\0", AdlMainControlCreate);
            let adlmaincontroldestroy: Symbol<AdlMainControlDestroy> =
                get_sym!(lib, b"ADL_Main_Control_Destroy\0", AdlMainControlDestroy);
            let adl_adapter_number_of_adapters_get: Symbol<AdlAdapterNumberofadaptersGet> =
                get_sym!(lib, b"ADL_Adapter_NumberOfAdapters_Get\0", AdlAdapterNumberofadaptersGet);
            let adl_adapter_adapter_info_get: Symbol<AdlAdapterAdapterinfoGet> =
                get_sym!(lib, b"ADL_Adapter_AdapterInfo_Get\0", AdlAdapterAdapterinfoGet);
            let adl_adapter_active_get: Symbol<AdlAdapterActiveGet> =
                get_sym!(lib, b"ADL_Adapter_Active_Get\0", AdlAdapterActiveGet);
            let adl2_create: Symbol<Adl2MainControlCreate> =
                get_sym!(lib, b"ADL2_Main_Control_Create\0", Adl2MainControlCreate);
            let adl2_destroy: Symbol<Adl2MainControlDestroy> =
                get_sym!(lib, b"ADL2_Main_Control_Destroy\0", Adl2MainControlDestroy);
            let adl_get_dedicated_vram_usage: Symbol<AdlGetDedicatedVramUsage> =
                get_sym!(lib, b"ADL2_Adapter_DedicatedVRAMUsage_Get\0", AdlGetDedicatedVramUsage);

            // TODO: try to put nullptr here. then we don't need direct libc dep
            if adlmaincontrolcreate(Some(adl_malloc), 1) != 0 {
                return Err("ADL initialization error!".into());
            }
            // After a successful create, ADL_Main_Control_Destroy must run on
            // every exit path, including the early error returns below. The
            // guard is declared after `lib` and the symbols, so it drops (and
            // destroys the context) before they are unloaded.
            let _destroy = super::CallOnDrop::new(|| {
                adlmaincontroldestroy();
            });

            // ADL2 calls need a real context; a null one makes them fail.
            let mut ctx: *mut c_void = ptr::null_mut();
            if adl2_create(Some(adl_malloc), 1, &mut ctx) != 0 || ctx.is_null() {
                return Err("ADL2 initialization error!".into());
            }
            let _destroy2 = super::CallOnDrop::new(|| {
                adl2_destroy(ctx);
            });

            let mut num_adapters: c_int = 0;
            if adl_adapter_number_of_adapters_get(&mut num_adapters as *mut _) != 0 {
                return Err("Cannot get number of adapters".into());
            }

            let mut vram_usages = Vec::new();

            if num_adapters > 0 {
                let mut adapter_info: Vec<AdapterInfo> =
                    vec![MaybeUninit::zeroed().assume_init(); num_adapters as usize];
                let ret = adl_adapter_adapter_info_get(
                    adapter_info.as_mut_ptr(),
                    mem::size_of::<AdapterInfo>() as i32 * num_adapters,
                );
                if ret != 0 {
                    return Err("Cannot get adapter info".into());
                }

                for adapter in adapter_info.iter() {
                    let mut is_active = 0;
                    if adl_adapter_active_get(adapter.iAdapterIndex, &mut is_active) != 0
                        || is_active == 0
                    {
                        continue;
                    }
                    let mut vram_mb = 0;
                    let ret =
                        adl_get_dedicated_vram_usage(ctx, adapter.iAdapterIndex, &mut vram_mb);
                    // A failed call is unknown, not 0 MB used.
                    let used_mb = if ret == 0 && vram_mb >= 0 {
                        Some(vram_mb as u64)
                    } else {
                        log::warn!("ADL VRAM usage call failed (code {ret})");
                        None
                    };
                    let name = CStr::from_ptr(adapter.strAdapterName.as_ptr())
                        .to_string_lossy()
                        .into_owned();
                    vram_usages.push(AdlUsage {
                        bus: adapter.iBusNumber as u32,
                        device: adapter.iDeviceNumber as u32,
                        function: adapter.iFunctionNumber as u32,
                        name,
                        used_mb,
                    });
                }
            }

            Ok(vram_usages)
        }
    }
}

/// Runs a cleanup closure when dropped, so it also runs on early returns.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct CallOnDrop<F: FnOnce()>(Option<F>);

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl<F: FnOnce()> CallOnDrop<F> {
    fn new(f: F) -> Self {
        Self(Some(f))
    }
}

impl<F: FnOnce()> Drop for CallOnDrop<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

#[cfg(test)]
mod call_on_drop_tests {
    use super::CallOnDrop;
    use std::cell::Cell;

    fn fails_after_init(calls: &Cell<u32>) -> Result<(), &'static str> {
        let _guard = CallOnDrop::new(|| calls.set(calls.get() + 1));
        Err("Cannot get number of adapters")
    }

    // Regression for #53: the ADL context must be destroyed on the early
    // error returns after a successful create, not only on success.
    #[test]
    fn cleanup_runs_on_an_early_error_return() {
        let calls = Cell::new(0);
        assert!(fails_after_init(&calls).is_err());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn cleanup_runs_exactly_once_on_success() {
        let calls = Cell::new(0);
        {
            let _guard = CallOnDrop::new(|| calls.set(calls.get() + 1));
        }
        assert_eq!(calls.get(), 1);
    }
}

#[cfg(test)]
mod amd_match_tests {
    use super::*;

    fn bus(b: u32) -> PciBusInfo {
        PciBusInfo {
            domain: 0,
            bus: b,
            device: 0,
            function: 0,
        }
    }

    #[test]
    fn parse_pci_slot_name_reads_the_address() {
        let uevent = "DRIVER=amdgpu\nPCI_CLASS=30000\nPCI_SLOT_NAME=0000:0b:00.1\nMODALIAS=x\n";
        assert_eq!(
            parse_pci_slot_name(uevent),
            Some(PciBusInfo {
                domain: 0,
                bus: 0x0b,
                device: 0,
                function: 1
            })
        );
        assert_eq!(parse_pci_slot_name("DRIVER=amdgpu\n"), None);
        assert_eq!(parse_pci_slot_name("PCI_SLOT_NAME=garbage\n"), None);
    }

    #[test]
    fn match_sysfs_by_bus_picks_second_card() {
        let cards = vec![
            SysfsCandidate {
                slot: Some(bus(3)),
                device_id: Some(0x744c),
            },
            SysfsCandidate {
                slot: Some(bus(7)),
                device_id: Some(0x744c),
            },
        ];
        assert_eq!(select_sysfs_candidate(Some(bus(7)), 0x744c, &cards), Some(1));
        assert_eq!(select_sysfs_candidate(Some(bus(9)), 0x744c, &cards), None);
    }

    #[test]
    fn identical_device_ids_without_bus_info_returns_none() {
        let cards = vec![
            SysfsCandidate {
                slot: Some(bus(3)),
                device_id: Some(0x744c),
            },
            SysfsCandidate {
                slot: Some(bus(7)),
                device_id: Some(0x744c),
            },
        ];
        assert_eq!(select_sysfs_candidate(None, 0x744c, &cards), None);
    }

    #[test]
    fn single_device_id_match_without_bus_info_is_used() {
        let cards = vec![
            SysfsCandidate {
                slot: None,
                device_id: Some(0x1111),
            },
            SysfsCandidate {
                slot: None,
                device_id: Some(0x744c),
            },
        ];
        assert_eq!(select_sysfs_candidate(None, 0x744c, &cards), Some(1));
    }

    fn adl(b: u32, name: &str, used: Option<u64>) -> AdlUsage {
        AdlUsage {
            bus: b,
            device: 0,
            function: 0,
            name: name.into(),
            used_mb: used,
        }
    }

    #[test]
    fn usage_unknown_when_call_fails() {
        let entries = vec![adl(3, "Radeon", None)];
        assert_eq!(pick_adl_usage(&entries, Some(bus(3)), "Radeon"), None);
    }

    #[test]
    fn adl_matches_by_bus_not_name() {
        let entries = vec![adl(3, "Radeon", Some(100)), adl(7, "Radeon", Some(900))];
        assert_eq!(pick_adl_usage(&entries, Some(bus(7)), "Radeon"), Some(900));
        // same name, no bus info: ambiguous, unknown
        assert_eq!(pick_adl_usage(&entries, None, "Radeon"), None);
    }

    #[test]
    fn adl_unique_name_fallback_and_real_zero() {
        let entries = vec![adl(3, "Radeon", Some(0))];
        assert_eq!(pick_adl_usage(&entries, None, "Radeon"), Some(0));
    }
}
