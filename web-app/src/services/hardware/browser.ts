/**
 * Browser Hardware Service - reports the machine the Flint server runs on.
 * Live usage sampling and GPU device selection stay unavailable until the
 * inference process is extracted from the desktop app.
 */

import { browserApi } from '@/services/browserApi'
import type {
  DeviceList,
  HardwareData,
  HardwareService,
  SystemSnapshot,
  SystemUsage,
} from './types'

export class BrowserHardwareService implements HardwareService {
  getHardwareInfo(): Promise<HardwareData | null> {
    return browserApi<HardwareData>('/api/v1/hardware/info')
  }

  async getSystemUsage(): Promise<SystemUsage | null> {
    return null
  }

  getSystemSnapshot(): Promise<SystemSnapshot | null> {
    return browserApi<SystemSnapshot>('/api/v1/hardware/snapshot')
  }

  async getLlamacppDevices(): Promise<DeviceList[]> {
    return []
  }

  async setActiveGpus(): Promise<void> {}

  async refreshHardwareInfo(): Promise<void> {
    await browserApi<void>('/api/v1/hardware/refresh', { method: 'POST' })
  }
}
