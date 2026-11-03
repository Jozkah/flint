import { invoke } from '@tauri-apps/api/core'

// Types
export interface NvidiaInfo {
  index: number;
  compute_capability: string;
  /** Highest CUDA version the driver supports ("12.4"). */
  cuda_driver_version?: string | null;
  architecture?: string | null;
}

export interface PciBusInfo {
  domain: number;
  bus: number;
  device: number;
  function: number;
}

export interface VulkanInfo {
  index: number;
  device_type: string;
  api_version: string;
  device_id: number;
  pci_bus_info?: PciBusInfo | null;
}

export interface CpuStaticInfo {
  name: string;
  core_count: number;
  arch: string;
  extensions: string[];
}

export interface GpuInfo {
  name: string;
  total_memory: number;
  vendor: string;
  uuid: string;
  driver_version: string;
  nvidia_info?: NvidiaInfo | null;
  vulkan_info?: VulkanInfo | null;
}

export interface SystemInfo {
  cpu: CpuStaticInfo;
  os_type: string;
  os_name: string;
  total_memory: number;
  gpus: GpuInfo[];
  /** UUIDs of the GPUs to use unless the user picks otherwise. */
  default_active_gpus: string[];
}

export interface GpuUsage {
  uuid: string;
  used_memory: number;
  total_memory: number;
}

export interface SystemUsage {
  cpu: number;
  used_memory: number;
  total_memory: number;
  /** Memory a new process can take now, in MiB. */
  available_memory: number;
  gpus: GpuUsage[];
}

// All sizes in bytes, temperatures in Celsius.
export interface CpuDetails {
  name: string;
  frequency_mhz: number;
  physical_cores: number | null;
  logical_cores: number;
  usage: number;
  per_core: number[];
}

export interface MemoryDetails {
  total: number;
  used: number;
  swap_total: number;
  swap_used: number;
}

export interface DiskDetails {
  name: string;
  mount_point: string;
  file_system: string;
  kind: string;
  total: number;
  available: number;
  removable: boolean;
}

export interface NetworkDetails {
  name: string;
  mac_address: string;
  total_received: number;
  total_transmitted: number;
}

export interface SensorDetails {
  label: string;
  kind: string;
  source: string;
  temperature: number | null;
  max: number | null;
  critical: number | null;
}

export interface SystemSnapshot {
  host_name: string | null;
  os_version: string | null;
  kernel_version: string | null;
  uptime_secs: number;
  timestamp_ms: number;
  cpu: CpuDetails;
  memory: MemoryDetails;
  disks: DiskDetails[];
  networks: NetworkDetails[];
  sensors: SensorDetails[];
}

// Hardware commands
export async function getSystemInfo(): Promise<SystemInfo> {
  return await invoke('plugin:hardware|get_system_info');
}

export async function getSystemUsage(): Promise<SystemUsage> {
  return await invoke('plugin:hardware|get_system_usage');
}

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  return await invoke('plugin:hardware|get_system_snapshot');
}

export async function refreshSystemInfo(): Promise<void> {
  return await invoke('plugin:hardware|refresh_system_info');
}
