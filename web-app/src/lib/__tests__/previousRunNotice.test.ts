import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ invoke: vi.fn(), warning: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => h.invoke(...a) }))
vi.mock('sonner', () => ({ toast: { warning: (...a: unknown[]) => h.warning(...a) } }))
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))

import { showPreviousRunNotice } from '../previousRunNotice'

describe('showPreviousRunNotice', () => {
  beforeEach(() => {
    h.invoke.mockReset()
    h.warning.mockReset()
  })

  it('shows nothing after a clean run', async () => {
    h.invoke.mockResolvedValue(null)
    await showPreviousRunNotice()
    expect(h.invoke).toHaveBeenCalledWith('take_previous_run_notice')
    expect(h.warning).not.toHaveBeenCalled()
  })

  it('warns once and exports the redacted log from the action', async () => {
    h.invoke.mockResolvedValueOnce({ unclean: true, reportPresent: false })
    h.invoke.mockResolvedValue(null)
    await showPreviousRunNotice()
    expect(h.warning).toHaveBeenCalledTimes(1)
    h.warning.mock.calls[0][1].action.onClick()
    expect(h.invoke).toHaveBeenCalledWith('export_redacted_logs')
  })

  it('swallows a missing command', async () => {
    h.invoke.mockRejectedValue(new Error('no such command'))
    await expect(showPreviousRunNotice()).resolves.toBeUndefined()
  })
})
