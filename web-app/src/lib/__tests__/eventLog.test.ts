/**
 * Recording run events never gets in the run's way: a backend that refuses
 * or is gone is logged, never thrown into the caller.
 */
import { describe, it, expect, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import { recordEvents } from '../eventLog'

describe('recordEvents', () => {
  it('sends the events and swallows a failed record', async () => {
    let fail: (e: unknown) => void = () => {}
    invoke.mockImplementation(() => new Promise((_, reject) => (fail = reject)))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      recordEvents([{ id: 'run:r1:started', session: 's1', run: 'r1', kind: 'run.started' }])
    ).not.toThrow()
    expect(invoke.mock.calls[0][0]).toBe('agent_events_record')
    expect(invoke.mock.calls[0][1].events[0]).toMatchObject({
      id: 'run:r1:started',
      kind: 'run.started',
      payload: {},
    })
    fail(new Error('backend gone'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })

  it('sends nothing for no events', () => {
    invoke.mockClear()
    recordEvents([])
    expect(invoke).not.toHaveBeenCalled()
  })
})
