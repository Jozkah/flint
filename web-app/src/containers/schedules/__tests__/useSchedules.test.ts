import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const list = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))
// A stable `t`, like the real hook: a fresh one per render would re-run the
// effect that depends on it forever.
const stableT = vi.hoisted(() => (k: string) => k)
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: stableT }),
}))
vi.mock('@/lib/schedules', () => ({
  SCHEDULE_EVENT: 'schedule',
  schedulesList: (...a: unknown[]) => list(...a),
  scheduleDelete: vi.fn(),
  scheduleRunNow: vi.fn(),
  scheduleSave: vi.fn(),
  scheduleSetEnabled: vi.fn(),
}))

import { useSchedules } from '../useSchedules'

const view = (id: string) => ({ task: { id } }) as never

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_TAURI', { value: true, writable: true, configurable: true })
  list.mockReset()
})
afterEach(() => {
  Object.defineProperty(globalThis, 'IS_TAURI', { value: false, writable: true, configurable: true })
})

describe('useSchedules refresh', () => {
  it('keeps the last good list when a later refresh fails', async () => {
    list.mockResolvedValueOnce([view('a')])
    const { result } = renderHook(() => useSchedules())
    await waitFor(() => expect(result.current.views).toHaveLength(1))
    list.mockRejectedValueOnce(new Error('boom'))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toContain('boom')
    expect(result.current.views).toHaveLength(1)
  })

  it('ignores a slow reply that arrives after a newer one', async () => {
    let slow!: (v: unknown[]) => void
    list.mockImplementationOnce(
      () => new Promise((res) => (slow = res as (v: unknown[]) => void))
    )
    const { result } = renderHook(() => useSchedules())
    list.mockResolvedValueOnce([view('new')])
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.views.map((v: { task: { id: string } }) => v.task.id)).toEqual(['new'])
    await act(async () => {
      slow([view('old')])
    })
    expect(result.current.views.map((v: { task: { id: string } }) => v.task.id)).toEqual(['new'])
  })
})
