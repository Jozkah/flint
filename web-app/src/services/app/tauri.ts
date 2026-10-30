/**
 * Tauri App Service - Desktop implementation
 */

import { AppConfiguration } from '@janhq/core'
import { invokeCommand } from '@/lib/backend'
import type {
  FactoryResetOptions,
  HfEndpointSetting,
  LogChunk,
  LogEntry,
} from './types'
import { DefaultAppService } from './default'
import { pruneLocalStorageByFlags } from './reset-localstorage'

export class TauriAppService extends DefaultAppService {
  /**
   * Factory reset with optional data preservation.
   *
   * User settings are persisted to `<jan_data>/settings.json` by the Rust
   * settings store (`core::app::settings_store`), and secrets to the OS keyring
   * (encrypted-file fallback `provider_secrets.enc`). The Rust `factory_reset`
   * command conditionally deletes directories, config files, `settings.json`,
   * and `provider_secrets.enc` based on the keep flags — no frontend
   * snapshot/restore is needed.
   *
   * localStorage still holds a frozen pre-migration snapshot (kept so a
   * downgraded build can read it). The reliable clear happens on next startup
   * via a Rust sentinel (see `main.tsx`) — renderer-side removal here is a
   * best-effort supplement that races the restart flush.
   */
  async factoryReset(options?: FactoryResetOptions): Promise<void> {
    const { EngineManager } = await import('@janhq/core')
    // A crashed engine must not block the reset: unload what can be unloaded.
    for (const [, engine] of EngineManager.instance().engines) {
      try {
        const activeModels = await engine.getLoadedModels()
        if (activeModels) {
          await Promise.allSettled(
            activeModels.map((model: string) => engine.unload(model))
          )
        }
      } catch (error) {
        console.error('Unloading models before reset failed:', error)
      }
    }

    const keepAppData = options?.keepAppData ?? false
    const keepModelsAndConfigs = options?.keepModelsAndConfigs ?? false
    const clearWebData = options?.clearWebData ?? false

    pruneLocalStorageByFlags({ keepAppData, keepModelsAndConfigs })

    if (!keepAppData && !keepModelsAndConfigs && !clearWebData) {
      await invokeCommand('factory_reset')
    } else {
      await invokeCommand('factory_reset', {
        keepAppData,
        keepModelsAndConfigs,
        clearWebData,
      })
    }
  }

  async readLogs(): Promise<LogEntry[]> {
    const logData: string = (await invokeCommand('read_logs')) ?? ''
    return logData.split('\n').filter(Boolean).map(this.parseLogLine)
  }

  async readLogsSince(offset?: number): Promise<LogChunk> {
    const chunk: { text: string; offset: number; reset: boolean } =
      await invokeCommand('read_logs_since', { offset: offset ?? null })
    return {
      entries: chunk.text
        .split('\n')
        .filter(Boolean)
        .map((line) => this.parseLogLine(line)),
      offset: chunk.offset,
      reset: chunk.reset,
    }
  }

  async getJanDataFolder(): Promise<string | undefined> {
    try {
      const appConfiguration: AppConfiguration | undefined =
        await window.core?.api?.getAppConfigurations()

      return appConfiguration?.data_folder
    } catch (error) {
      console.error('Failed to get Jan data folder:', error)
      return undefined
    }
  }

  async getUnavailableJanDataFolder(): Promise<string | undefined> {
    try {
      // Set by the backend when the saved data folder could not be used this
      // run (janhq/jan#8855); never part of the saved configuration.
      const appConfiguration:
        | (AppConfiguration & { unavailable_data_folder?: string })
        | undefined = await window.core?.api?.getAppConfigurations()
      return appConfiguration?.unavailable_data_folder || undefined
    } catch (error) {
      console.error('Failed to get Jan data folder:', error)
      return undefined
    }
  }

  async relocateJanDataFolder(path: string): Promise<void> {
    await window.core?.api?.changeAppDataFolder({ newDataFolder: path })
  }

  parseLogLine(line: string): LogEntry {
    const regex = /^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\s(.*)$/
    const match = line.match(regex)

    if (!match)
      return {
        timestamp: Date.now(),
        level: 'info' as 'info' | 'warn' | 'error' | 'debug',
        target: 'info',
        message: line ?? '',
      } as LogEntry

    const [, date, time, target, levelRaw, message] = match

    const level = levelRaw.toLowerCase() as 'info' | 'warn' | 'error' | 'debug'

    return {
      timestamp: `${date} ${time}`,
      level,
      target,
      message,
    }
  }

  async getServerStatus(): Promise<boolean> {
    return await invokeCommand<boolean>('get_server_status')
  }

  async setServerRunInBackground(enabled: boolean): Promise<void> {
    await invokeCommand('set_server_run_in_background', { enabled })
  }

  async setCloseToTray(enabled: boolean): Promise<void> {
    await invokeCommand('set_close_to_tray', { enabled })
  }

  async setDownloadSpeedLimit(bytesPerSec: number): Promise<void> {
    await invokeCommand('set_download_speed_limit', { bytesPerSec })
  }

  async getHfEndpointSetting(): Promise<HfEndpointSetting> {
    return await invokeCommand<HfEndpointSetting>('get_hf_endpoint_setting')
  }

  async setHfEndpointSetting(
    endpoint: string,
    sendTokenToMirror: boolean
  ): Promise<void> {
    await invokeCommand('set_hf_endpoint_setting', { endpoint, sendTokenToMirror })
  }

  async exportRedactedLogs(): Promise<string | null> {
    return await invokeCommand<string | null>('export_redacted_logs')
  }

  async exportDiagnosticBundle(): Promise<string | null> {
    return await invokeCommand<string | null>('export_diagnostic_bundle')
  }

  async readYaml<T = unknown>(path: string): Promise<T> {
    return await invokeCommand<T>('read_yaml', { path })
  }
}
