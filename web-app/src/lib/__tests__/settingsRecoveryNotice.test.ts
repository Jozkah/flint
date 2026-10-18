import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
const warning = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('sonner', () => ({ toast: { warning: (...a: unknown[]) => warning(...a) } }))
vi.mock('@/i18n', () => ({
  default: { t: (k: string, o?: Record<string, string>) => `${k}|${o?.backup ?? ''}` },
}))

import {
  notifyToasterMounted,
  showSettingsRecoveryNotice,
} from '../settingsRecoveryNotice'

describe('showSettingsRecoveryNotice', () => {
  beforeEach(() => {
    invoke.mockReset()
    warning.mockReset()
  })

  it('shows nothing when settings were fine', async () => {
    invoke.mockResolvedValue(null)
    await showSettingsRecoveryNotice()
    expect(warning).not.toHaveBeenCalled()
  })

  it('names the backup file when settings were corrupt', async () => {
    invoke.mockResolvedValue({ file: 'C:/d/settings.json', backup: 'C:/d/settings.json.corrupt-1' })
    await showSettingsRecoveryNotice()
    expect(invoke).toHaveBeenCalledWith('take_settings_recovery_notice')
    const desc = warning.mock.calls[0][1].description as string
    expect(desc).toContain('withBackup')
    expect(desc).toContain('settings.json.corrupt-1')
  })

  it('uses the no-backup text when the copy failed', async () => {
    invoke.mockResolvedValue({ file: 'C:/d/settings.json', backup: null })
    await showSettingsRecoveryNotice()
    expect(warning.mock.calls[0][1].description).toContain('noBackup')
  })

  it('swallows a missing command', async () => {
    invoke.mockRejectedValue(new Error('no such command'))
    await expect(showSettingsRecoveryNotice()).resolves.toBeUndefined()
  })

  it('shows the notice again when the Toaster mounts after it was raised', async () => {
    invoke.mockResolvedValue({ file: 'C:/d/settings.json', backup: 'C:/d/settings.json.corrupt-2' })
    await showSettingsRecoveryNotice()
    expect(warning).toHaveBeenCalledTimes(1)
    notifyToasterMounted()
    expect(warning).toHaveBeenCalledTimes(2)
    // Mounting again later must not repeat it.
    notifyToasterMounted()
    expect(warning).toHaveBeenCalledTimes(2)
  })
})
