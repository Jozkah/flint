/**
 * Tauri Hardware Service - Desktop implementation
 */

import type {
  HardwareData,
  SystemUsage,
  SystemSnapshot,
  DeviceList,
} from './types'
import { invokeCommand } from '@/lib/backend'
import { DefaultHardwareService } from './default'

export class TauriHardwareService extends DefaultHardwareService {
  async getHardwareInfo(): Promise<HardwareData | null> {
    return invokeCommand('plugin:hardware|get_system_info') as Promise<HardwareData>
  }

  async getSystemUsage(): Promise<SystemUsage | null> {
    return invokeCommand('plugin:hardware|get_system_usage') as Promise<SystemUsage>
  }

  async getSystemSnapshot(): Promise<SystemSnapshot | null> {
    return invokeCommand('plugin:hardware|get_system_snapshot') as Promise<SystemSnapshot>
  }

  async getLlamacppDevices(): Promise<DeviceList[]> {
    const extensionManager = window.core.extensionManager
    const llamacppExtension = extensionManager.getByName('@janhq/llamacpp-extension')

    if (!llamacppExtension) {
      throw new Error('llamacpp extension not found')
    }

    return llamacppExtension.getDevices()
  }

  async setActiveGpus(data: { gpus: number[] }): Promise<void> {
    // TODO: llama.cpp extension should handle this
    console.log(data)
  }

  async refreshHardwareInfo(): Promise<void> {
    await invokeCommand('plugin:hardware|refresh_system_info')
  }
}
