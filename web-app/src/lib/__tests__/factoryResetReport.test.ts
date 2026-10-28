import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ invoke: vi.fn(), warning: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => h.invoke(...a) }))
vi.mock('sonner', () => ({ toast: { warning: (...a: unknown[]) => h.warning(...a) } }))
vi.mock('@/i18n', () => ({
  default: { t: (k: string, o?: Record<string, unknown>) => `${k}|${o?.count ?? ''}|${o?.list ?? ''}` },
}))

import { showFactoryResetReport } from '../factoryResetReport'
import { notifyToasterMounted } from '../settingsRecoveryNotice'

describe('showFactoryResetReport', () => {
  beforeEach(() => {
    h.invoke.mockReset()
    h.warning.mockReset()
  })

  it('shows nothing when the reset was clean', async () => {
    h.invoke.mockResolvedValue(null)
    await showFactoryResetReport()
    expect(h.invoke).toHaveBeenCalledWith('take_factory_reset_report')
    expect(h.warning).not.toHaveBeenCalled()
  })

  it('lists the paths that could not be removed', async () => {
    h.invoke.mockResolvedValue({ failures: ['C:/d/threads: denied', 'C:/d/logs: busy'] })
    await showFactoryResetReport()
    const desc = h.warning.mock.calls[0][1].description as string
    expect(desc).toContain('|2|')
    expect(desc).toContain('logs: busy')
  })

  it('swallows a missing command', async () => {
    h.invoke.mockRejectedValue(new Error('no such command'))
    await expect(showFactoryResetReport()).resolves.toBeUndefined()
  })

  it('shows again when the Toaster mounts after it was raised', async () => {
    h.invoke.mockResolvedValue({ failures: ['x'] })
    await showFactoryResetReport()
    notifyToasterMounted()
    expect(h.warning).toHaveBeenCalledTimes(2)
  })
})
