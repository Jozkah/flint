use crate::types::GpuInfo;

#[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
use {
    crate::types::Vendor,
    vulkano::device::physical::PhysicalDeviceType,
    vulkano::instance::{Instance, InstanceCreateInfo},
    vulkano::memory::MemoryHeapFlags,
    vulkano::VulkanLibrary,
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct VulkanInfo {
    pub index: u64,
    pub device_type: String,
    pub api_version: String,
    pub device_id: u32,
    /// PCI location from VK_EXT_pci_bus_info. None when the driver does not
    /// report it; cards are then not told apart by device id.
    #[serde(default)]
    pub pci_bus_info: Option<PciBusInfo>,
}

/// PCI address of a GPU.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct PciBusInfo {
    pub domain: u32,
    pub bus: u32,
    pub device: u32,
    pub function: u32,
}

/// Reads VK_EXT_pci_bus_info for a physical device. None if the instance is
/// older than Vulkan 1.1, the extension is missing, or any call fails.
#[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
fn query_pci_bus_info(
    instance: &Instance,
    physical_device: &vulkano::device::physical::PhysicalDevice,
) -> Option<PciBusInfo> {
    use ash::vk;
    use std::ffi::{c_void, CStr};
    use vulkano::VulkanObject;

    if instance.api_version() < vulkano::Version::V1_1 {
        return None;
    }
    let fns = instance.fns();
    let handle = physical_device.handle();
    unsafe {
        let mut count = 0u32;
        let r = (fns.v1_0.enumerate_device_extension_properties)(
            handle,
            std::ptr::null(),
            &mut count,
            std::ptr::null_mut(),
        );
        if r != vk::Result::SUCCESS || count == 0 {
            return None;
        }
        let mut exts = vec![vk::ExtensionProperties::default(); count as usize];
        let r = (fns.v1_0.enumerate_device_extension_properties)(
            handle,
            std::ptr::null(),
            &mut count,
            exts.as_mut_ptr(),
        );
        if r != vk::Result::SUCCESS && r != vk::Result::INCOMPLETE {
            return None;
        }
        exts.truncate(count as usize);
        let has_ext = exts.iter().any(|e| {
            CStr::from_ptr(e.extension_name.as_ptr()).to_bytes() == b"VK_EXT_pci_bus_info"
        });
        if !has_ext {
            return None;
        }

        let mut pci = vk::PhysicalDevicePCIBusInfoPropertiesEXT::default();
        let mut props2 = vk::PhysicalDeviceProperties2::default();
        props2.p_next = &mut pci as *mut _ as *mut c_void;
        (fns.v1_1.get_physical_device_properties2)(handle, &mut props2);
        Some(PciBusInfo {
            domain: pci.pci_domain,
            bus: pci.pci_bus,
            device: pci.pci_device,
            function: pci.pci_function,
        })
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
fn parse_uuid(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-\
         {:02x}{:02x}-\
         {:02x}{:02x}-\
         {:02x}{:02x}-\
         {:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

pub fn get_vulkan_gpus() -> Vec<GpuInfo> {
    #[cfg(any(target_os = "android", target_os = "ios", target_os = "macos"))]
    {
        log::info!("Vulkan GPU detection is not supported on mobile platforms");
        vec![]
    }

    #[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
    {
        match get_vulkan_gpus_internal() {
            Ok(gpus) => gpus,
            Err(e) => {
                log::error!("Failed to get Vulkan GPUs: {:?}", e);
                vec![]
            }
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios", target_os = "macos")))]
fn get_vulkan_gpus_internal() -> Result<Vec<GpuInfo>, Box<dyn std::error::Error>> {
    let library = VulkanLibrary::new()?;

    let instance = Instance::new(
        library,
        InstanceCreateInfo {
            application_name: Some("Jan GPU Detection".into()),
            application_version: vulkano::Version::V1_1,
            ..Default::default()
        },
    )?;

    let mut device_info_list = vec![];

    for (i, physical_device) in instance.enumerate_physical_devices()?.enumerate() {
        let properties = physical_device.properties();

        if properties.device_type == PhysicalDeviceType::Cpu {
            continue;
        }

        // Software rasterizers (llvmpipe, SwiftShader, lavapipe) can report a
        // non-CPU device type; they are not a GPU to offload to.
        let lower_name = properties.device_name.to_lowercase();
        if ["llvmpipe", "swiftshader", "lavapipe", "softpipe"]
            .iter()
            .any(|n| lower_name.contains(n))
        {
            continue;
        }

        let memory_properties = physical_device.memory_properties();
        let total_memory: u64 = memory_properties
            .memory_heaps
            .iter()
            .filter(|heap| heap.flags.intersects(MemoryHeapFlags::DEVICE_LOCAL))
            .map(|heap| heap.size / (1024 * 1024))
            // The largest heap, not the sum: drivers can expose the same VRAM
            // through more than one device-local heap (a BAR window), and
            // adding them overstated what fits.
            .max()
            .unwrap_or(0);

        // No device-local memory at all: nothing can be offloaded to it.
        if total_memory == 0
            && properties.device_type != PhysicalDeviceType::IntegratedGpu
        {
            continue;
        }

        let device_uuid = physical_device.properties().device_uuid.unwrap_or([0; 16]);
        let driver_version = format!("{}", properties.driver_version);

        // Drivers that report no device UUID give every GPU the all-zero one,
        // which made a second GPU overwrite the first when the lists merge.
        let uuid = if device_uuid == [0; 16] {
            format!(
                "vulkan-{:04x}-{:04x}-{}",
                properties.vendor_id, properties.device_id, i
            )
        } else {
            parse_uuid(&device_uuid)
        };

        let device_info = GpuInfo {
            name: properties.device_name.clone(),
            total_memory,
            vendor: Vendor::from_vendor_id(properties.vendor_id),
            uuid,
            driver_version,
            nvidia_info: None,
            vulkan_info: Some(VulkanInfo {
                index: i as u64,
                device_type: format!("{:?}", properties.device_type),
                api_version: format!(
                    "{}.{}.{}",
                    properties.api_version.major,
                    properties.api_version.minor,
                    properties.api_version.patch
                ),
                device_id: properties.device_id,
                pci_bus_info: query_pci_bus_info(&instance, &physical_device),
            }),
        };
        device_info_list.push(device_info);
    }

    Ok(device_info_list)
}
