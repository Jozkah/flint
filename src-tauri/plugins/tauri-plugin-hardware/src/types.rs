use serde::Serialize;

use crate::vendor::{nvidia::NvidiaInfo, vulkan::VulkanInfo};

#[derive(Clone, Serialize, Debug)]
pub struct CpuStaticInfo {
    pub name: String,
    pub core_count: usize,
    pub arch: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum Vendor {
    AMD,
    NVIDIA,
    Intel,
    Unknown(u32),
}

impl Serialize for Vendor {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Vendor::AMD => "AMD".serialize(serializer),
            Vendor::NVIDIA => "NVIDIA".serialize(serializer),
            Vendor::Intel => "Intel".serialize(serializer),
            Vendor::Unknown(vendor_id) => {
                let formatted = format!("Unknown (vendor_id: {})", vendor_id);
                serializer.serialize_str(&formatted)
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub total_memory: u64,
    pub vendor: Vendor,
    pub uuid: String,
    pub driver_version: String,
    pub nvidia_info: Option<NvidiaInfo>,
    pub vulkan_info: Option<VulkanInfo>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SystemInfo {
    pub cpu: CpuStaticInfo,
    pub os_type: String,
    pub os_name: String,
    pub total_memory: u64,
    pub gpus: Vec<GpuInfo>,
    /// UUIDs of the GPUs to use unless the user picks otherwise: discrete
    /// cards when any exists (integrated and virtual ones are left out), and
    /// NVIDIA only when an NVIDIA card is present. Device data, not a choice.
    #[serde(default)]
    pub default_active_gpus: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuUsage {
    pub uuid: String,
    pub used_memory: u64,
    pub total_memory: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct SystemUsage {
    pub cpu: f32,
    pub used_memory: u64,
    pub total_memory: u64,
    /// Memory a new process can actually take now, in MiB (the OS's
    /// "available" figure: free plus reclaimable, free+inactive on macOS).
    pub available_memory: u64,
    pub gpus: Vec<GpuUsage>,
}
