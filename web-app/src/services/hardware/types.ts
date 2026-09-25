/**
 * Hardware Service Types
 */

import type { HardwareData, SystemUsage } from '@/hooks/useHardware'
import type { SystemSnapshot } from '@/lib/systemMonitor'

// Device list interface for llamacpp extension
export interface DeviceList {
  id: string
  name: string
  mem: number
  free: number
  activated: boolean
}

export interface HardwareService {
  getHardwareInfo(): Promise<HardwareData | null>
  getSystemUsage(): Promise<SystemUsage | null>
  /** Drives, network counters, sensors, per-core CPU, swap and uptime. */
  getSystemSnapshot(): Promise<SystemSnapshot | null>
  getLlamacppDevices(): Promise<DeviceList[]>
  setActiveGpus(data: { gpus: number[] }): Promise<void>
  /** Invalidates cached GPU detection so next getHardwareInfo() re-detects. Use after system resume (e.g. Linux sleep). */
  refreshHardwareInfo(): Promise<void>
}

// Re-export hardware types for convenience
export type { HardwareData, SystemUsage, SystemSnapshot }
