import { invokeCommand as invoke } from '@/lib/backend'

/**
 * Whether the runtime note sent to the model names the OS account and profile
 * folders. On by default (it stops the model guessing profile paths); stored
 * as `user_line` in `~/.jan/config.toml`, which the CLI reads too.
 */
const inTauri = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

export async function getUserLineSetting(): Promise<boolean> {
  if (!inTauri()) return true
  return invoke<boolean>('get_user_line_setting')
}

export async function setUserLineSetting(enabled: boolean): Promise<boolean> {
  return invoke<boolean>('set_user_line_setting', { enabled })
}
