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
    // Queued behind earlier records, so it goes out on the next tick.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
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

  // The backend numbers events as they arrive; a step's response once landed
  // after the run's end because two records raced.
  it('sends records one after another, in the order they were made', async () => {
    invoke.mockReset()
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    invoke.mockImplementation((_cmd: string, args: { events: { id: string }[] }) => {
      const id = args.events[0].id
      order.push(`start:${id}`)
      if (id === 'message:1') {
        return new Promise<void>((resolve) => {
          releaseFirst = () => {
            order.push(`end:${id}`)
            resolve()
          }
        })
      }
      order.push(`end:${id}`)
      return Promise.resolve()
    })
    void recordEvents([{ id: 'message:1', session: 's1', run: 'r1', kind: 'message.completed' }])
    const second = recordEvents([{ id: 'run:r1:ended', session: 's1', run: 'r1', kind: 'run.ended' }])
    await vi.waitFor(() => expect(order).toEqual(['start:message:1']))
    releaseFirst()
    await second
    expect(order).toEqual(['start:message:1', 'end:message:1', 'start:run:r1:ended', 'end:run:r1:ended'])
  })
})
