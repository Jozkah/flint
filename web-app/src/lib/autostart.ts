import { invoke } from '@tauri-apps/api/core'

/**
 * "Start with the computer": an opt-in entry in the OS's per-user startup
 * list. `minimized` is part of the entry itself (a `--minimized` argument).
 */
export interface AutostartStatus {
  platform: 'windows' | 'mac_os' | 'linux'
  platformLabel: string
  enabled: boolean
  minimized: boolean
  /** The exact lines that are (or would be) written. */
  preview: string[]
  detail: string | null
}

export const autostartGet = (minimized?: boolean) =>
  invoke<AutostartStatus>('autostart_get', { minimized })

export const autostartSet = (enabled: boolean, minimized?: boolean) =>
  invoke<AutostartStatus>('autostart_set', { enabled, minimized })
