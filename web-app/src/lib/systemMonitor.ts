/**
 * Types and pure helpers for the System Monitor page: the shape of the
 * hardware plugin's `get_system_snapshot`, network rates derived from two
 * snapshots, and the formatting the page uses for bytes, rates, uptime and
 * temperatures.
 */

export interface CpuDetails {
  name: string
  frequency_mhz: number
  physical_cores: number | null
  logical_cores: number
  usage: number
  per_core: number[]
}

export interface MemoryDetails {
  total: number
  used: number
  swap_total: number
  swap_used: number
}

export interface DiskDetails {
  name: string
  mount_point: string
  file_system: string
  kind: 'SSD' | 'HDD' | 'Unknown'
  total: number
  available: number
  removable: boolean
}

export interface NetworkDetails {
  name: string
  mac_address: string
  total_received: number
  total_transmitted: number
}

export interface SensorDetails {
  label: string
  kind: 'cpu' | 'gpu' | 'disk' | 'other'
  /** Where the reading came from ("sysinfo", "NVML", a WMI class). */
  source: string
  temperature: number | null
  max: number | null
  critical: number | null
}

/** Sizes in bytes, temperatures in Celsius. */
export interface SystemSnapshot {
  host_name: string | null
  os_version: string | null
  kernel_version: string | null
  uptime_secs: number
  timestamp_ms: number
  cpu: CpuDetails
  memory: MemoryDetails
  disks: DiskDetails[]
  networks: NetworkDetails[]
  sensors: SensorDetails[]
}

export interface NetworkRate {
  /** Bytes per second received. */
  rx: number
  /** Bytes per second transmitted. */
  tx: number
}

/**
 * Per-interface rates between two snapshots, keyed by interface name.
 * Interfaces missing from the previous snapshot have no rate yet. A counter
 * that went backwards (adapter reset) reads as zero rather than negative.
 */
export function computeNetworkRates(
  prev: Pick<SystemSnapshot, 'timestamp_ms' | 'networks'> | null | undefined,
  next: Pick<SystemSnapshot, 'timestamp_ms' | 'networks'>
): Record<string, NetworkRate> {
  const rates: Record<string, NetworkRate> = {}
  if (!prev) return rates
  const seconds = (next.timestamp_ms - prev.timestamp_ms) / 1000
  if (!(seconds > 0)) return rates
  const before = new Map(prev.networks.map((n) => [n.name, n]))
  for (const n of next.networks) {
    const p = before.get(n.name)
    if (!p) continue
    rates[n.name] = {
      rx: Math.max(0, n.total_received - p.total_received) / seconds,
      tx: Math.max(0, n.total_transmitted - p.total_transmitted) / seconds,
    }
  }
  return rates
}

const VIRTUAL_PATTERNS = [
  /^lo\d*$/i,
  /loopback/i,
  /pseudo-interface/i,
  /^veth/i,
  /^docker/i,
  /^br-/i,
  /^virbr/i,
  /^vmnet/i,
  /^vboxnet/i,
  /^vethernet/i,
  /virtualbox/i,
  /vmware/i,
  /hyper-v/i,
  /\bwsl\b/i,
  /^tun\d*/i,
  /^tap/i,
  /^utun\d*/i,
  /^awdl\d*/i,
  /^llw\d*/i,
  /^anpi\d*/i,
  /^bridge\d*/i,
  /^gif\d*/i,
  /^stf\d*/i,
  /teredo/i,
  /isatap/i,
  /npcap/i,
  /bluetooth/i,
  /tailscale/i,
  /wireguard/i,
  /zerotier/i,
  /^local area connection\*/i, // Windows Wi-Fi Direct virtual adapters
]

const ZERO_MAC = /^(00[:-]){5}00$/

/** Loopback, container, VM, VPN and tunnel adapters. */
export function isVirtualInterface(name: string, mac?: string): boolean {
  if (VIRTUAL_PATTERNS.some((re) => re.test(name))) return true
  return mac !== undefined && ZERO_MAC.test(mac)
}

export type InterfaceKind = 'wifi' | 'ethernet' | 'other'

export function interfaceKind(name: string): InterfaceKind {
  if (/wi-?fi|wlan|wireless|^wl|802\.11|airport/i.test(name)) return 'wifi'
  if (/ethernet|^eth|^en/i.test(name)) return 'ethernet'
  return 'other'
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Binary-prefixed size: 1536 -> "1.5 KB". */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(digits)} ${UNITS[unit]}`
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/** "3d 4h 12m", "4h 12m", "12m"; under a minute reads "<1m". */
export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 60) return '<1m'
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatTemperature(celsius: number | null | undefined): string {
  if (celsius == null || !Number.isFinite(celsius)) return '—'
  return `${Math.round(celsius)} °C`
}

export function formatFrequency(mhz: number): string {
  if (!Number.isFinite(mhz) || mhz <= 0) return '—'
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`
}

/** Used share of a disk, percent. */
export function diskUsedPercent(disk: Pick<DiskDetails, 'total' | 'available'>): number {
  if (!(disk.total > 0)) return 0
  return ((disk.total - Math.min(disk.available, disk.total)) / disk.total) * 100
}
