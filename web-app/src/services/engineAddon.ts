/**
 * The NVIDIA CUDA engine add-on: a pack the desktop app downloads, verifies and
 * installs on the user's request (src-tauri/plugins/tauri-plugin-llamacpp/src/
 * engine/addon.rs). Desktop only: the browser client and `flint serve` get
 * nothing, so every call here resolves to "unsupported" off the desktop.
 */
import {
  engineAddonCancel,
  engineAddonCheck,
  engineAddonDownload,
  engineAddonInstallFile,
  engineAddonRemove,
  engineAddonStatus,
  engineAddonVerify,
} from '@janhq/tauri-plugin-llamacpp-api'
import { isServedByFlint } from '@/lib/platform/utils'

export type AddonEligibility =
  | 'unsupported_platform'
  | 'no_nvidia'
  | 'gpu_too_old'
  | 'driver_unknown'
  | 'driver_too_old'
  | 'already_bundled'
  | 'eligible'

export interface AddonFailure {
  code: string
  message: string
}

export interface InstalledAddon {
  kind: string
  release_tag: string
  engine_tag: string
  size: number
  dir: string
  compatible: boolean
  problem: AddonFailure | null
}

export interface AddonStatus {
  supported: boolean
  signing_configured: boolean
  kind: string
  release_tag: string
  eligibility: AddonEligibility
  driver_version: string | null
  min_driver: number
  installed: InstalledAddon[]
  in_use: string | null
  restart_pending: boolean
  downloading: boolean
}

export interface RemotePack {
  release_tag: string
  archive_size: number
  installed_size: number
  min_driver: number
  min_compute: number
  cuda_toolkit: string | null
}

export interface AddonProgress {
  phase: 'download' | 'verify' | 'install'
  received: number
  total: number
}

export const ADDON_PROGRESS_EVENT = 'engine-addon-progress'

/** The CUDA pack's download size when the manifest could not be read yet. */
export const TYPICAL_PACK_MB = 410

export const addonsAvailableHere = (): boolean =>
  typeof IS_TAURI !== 'undefined' && IS_TAURI && !isServedByFlint() && !IS_MACOS

/** A rejected command's payload, as the plugin words it. */
export function parseAddonFailure(error: unknown): AddonFailure {
  const text = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(text) as Partial<AddonFailure>
    if (parsed && typeof parsed.code === 'string') {
      return { code: parsed.code, message: String(parsed.message ?? '') }
    }
  } catch {
    // not the structured shape
  }
  return { code: 'io', message: text }
}

export const engineAddon = {
  status: () => engineAddonStatus<AddonStatus>(),
  check: () => engineAddonCheck<RemotePack>(),
  download: () => engineAddonDownload<InstalledAddon>(),
  cancel: () => engineAddonCancel(),
  installFile: (path: string) => engineAddonInstallFile<InstalledAddon>(path),
  remove: () => engineAddonRemove(),
  verify: () => engineAddonVerify(),
  async onProgress(cb: (p: AddonProgress) => void): Promise<() => void> {
    const { listen } = await import('@tauri-apps/api/event')
    return listen<AddonProgress>(ADDON_PROGRESS_EVENT, (e) => cb(e.payload))
  },
}

/** An add-on that loads with this build is installed. */
export const hasUsableAddon = (status: AddonStatus | null | undefined): boolean =>
  Boolean(status?.installed.some((a) => a.compatible))
