import type { FactoryResetOptions } from '@/services/app/types'
import { isRootDir } from '@/utils/path'

export type FactoryResetDeps = {
  getDataFolder: () => Promise<string | undefined>
  factoryReset: (options: FactoryResetOptions) => Promise<void>
  pausePolling: () => void
  resumePolling: () => void
  onRootDir: () => void
  onError: (error: unknown) => void
}

/**
 * Run a factory reset from settings. Hardware polling is paused while the
 * backend stops services; if the reset fails (the app does not restart) it
 * is resumed and the error shown, instead of leaving the monitor frozen.
 */
export async function runFactoryReset(
  options: FactoryResetOptions,
  deps: FactoryResetDeps
): Promise<void> {
  let folder: string | undefined
  try {
    folder = await deps.getDataFolder()
  } catch (error) {
    deps.onError(error)
    return
  }
  // Only a known root folder is refused; an unknown one is checked again by
  // the backend before anything is deleted.
  if (folder && isRootDir(folder)) {
    deps.onRootDir()
    return
  }
  deps.pausePolling()
  try {
    await deps.factoryReset(options)
  } catch (error) {
    deps.resumePolling()
    deps.onError(error)
  }
}
