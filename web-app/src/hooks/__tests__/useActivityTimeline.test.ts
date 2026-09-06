import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useActivityTimeline, selectActivityLog } from '../useActivityTimeline'
import type { IncomingActivityEvent } from '@/lib/activityEvents'

function event(
  over: Partial<IncomingActivityEvent> & Pick<IncomingActivityEvent, 'id' | 'at' | 'sessionId'>
): IncomingActivityEvent {
  return {
    kind: 'command',
    status: 'ok',
    title: 'Ran a command',
    detail: { kind: 'command', command: { command: 'ls' } },
    ...over,
  }
}

describe('useActivityTimeline', () => {
  beforeEach(() => {
    useActivityTimeline.setState({ logs: {} })
  })

  it('creates a session log on the first event and appends to it after', () => {
    const { record } = useActivityTimeline.getState()
    record(event({ id: 'a', at: 1, sessionId: 's1' }))
    record(event({ id: 'b', at: 2, sessionId: 's1' }))
    expect(useActivityTimeline.getState().logs['s1'].events.map((e) => e.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('keeps sessions apart, including an event that arrives for another one', () => {
    const { record } = useActivityTimeline.getState()
    record(event({ id: 'a', at: 1, sessionId: 's1' }))
    record(event({ id: 'a', at: 1, sessionId: 's2' }))
    const { logs } = useActivityTimeline.getState()
    expect(Object.keys(logs).sort()).toEqual(['s1', 's2'])
    expect(logs['s1'].events).toHaveLength(1)
    expect(logs['s2'].events).toHaveLength(1)
    expect(logs['s1'].events[0].sessionId).toBe('s1')
  })

  it('records a batch as one update', () => {
    const updates: number[] = []
    const unsubscribe = useActivityTimeline.subscribe(() => updates.push(1))
    useActivityTimeline.getState().recordMany([
      event({ id: 'a', at: 1, sessionId: 's1' }),
      event({ id: 'b', at: 2, sessionId: 's1' }),
      event({ id: 'c', at: 3, sessionId: 's2' }),
    ])
    unsubscribe()
    expect(updates).toHaveLength(1)
    expect(useActivityTimeline.getState().logs['s1'].events).toHaveLength(2)
    expect(useActivityTimeline.getState().logs['s2'].events).toHaveLength(1)
  })

  it('patches a known event and ignores one for a session it has never seen', () => {
    const { record, patch } = useActivityTimeline.getState()
    record(event({ id: 'cmd', at: 1, sessionId: 's1', status: 'pending' }))
    patch('s1', 'cmd', { status: 'ok' })
    expect(useActivityTimeline.getState().logs['s1'].events[0].status).toBe('ok')

    const before = useActivityTimeline.getState().logs
    patch('nope', 'cmd', { status: 'error' })
    expect(useActivityTimeline.getState().logs).toBe(before)
  })

  it('cancels a session without touching another one', () => {
    const { record, cancelSession } = useActivityTimeline.getState()
    record(event({ id: 'a', at: 1, sessionId: 's1', status: 'pending' }))
    record(event({ id: 'b', at: 1, sessionId: 's2', status: 'pending' }))
    cancelSession('s1', 'stopped')

    const { logs } = useActivityTimeline.getState()
    expect(logs['s1'].events.find((e) => e.id === 'a')!.status).toBe('cancelled')
    expect(logs['s1'].events.some((e) => e.kind === 'cancelled')).toBe(true)
    expect(logs['s2'].events[0].status).toBe('pending')
  })

  it('drops a deleted session and leaves the rest alone', () => {
    const { record, dropSession } = useActivityTimeline.getState()
    record(event({ id: 'a', at: 1, sessionId: 's1' }))
    record(event({ id: 'b', at: 1, sessionId: 's2' }))
    dropSession('s1')
    expect(Object.keys(useActivityTimeline.getState().logs)).toEqual(['s2'])
  })

  it('settles what a previous app run left in flight, in every session', () => {
    const { record, recoverOnLoad } = useActivityTimeline.getState()
    record(event({ id: 'running', at: 1, sessionId: 's1', status: 'pending' }))
    record(event({ id: 'finished', at: 2, sessionId: 's1', status: 'ok' }))
    record(event({ id: 'also-running', at: 1, sessionId: 's2', status: 'pending' }))
    recoverOnLoad('interrupted:restart')

    const { logs } = useActivityTimeline.getState()
    expect(logs['s1'].events.find((e) => e.id === 'running')!.status).toBe('cancelled')
    expect(logs['s1'].events.find((e) => e.id === 'finished')!.status).toBe('ok')
    expect(logs['s2'].events.find((e) => e.id === 'also-running')!.status).toBe('cancelled')
    // And the reason is on the record, not only in the log line.
    const stop = logs['s1'].events.find((e) => e.kind === 'cancelled')!
    expect(stop.detail).toMatchObject({ outcome: { reason: 'interrupted:restart' } })
  })

  it('leaves the state identical when there is nothing in flight to settle', () => {
    const { record, recoverOnLoad } = useActivityTimeline.getState()
    record(event({ id: 'done', at: 1, sessionId: 's1', status: 'ok' }))
    const before = useActivityTimeline.getState().logs
    recoverOnLoad('interrupted:restart')
    expect(useActivityTimeline.getState().logs).toBe(before)
  })

  it('selects the same empty log every time for a session with no events', () => {
    const state = useActivityTimeline.getState()
    const a = selectActivityLog(state, 'unknown')
    const b = selectActivityLog(state, 'also-unknown')
    const none = selectActivityLog(state, undefined)
    expect(a).toBe(b)
    expect(a).toBe(none)
    expect(a.events).toEqual([])
  })

  it('persists only the record, so actions are rebuilt on load', () => {
    useActivityTimeline.getState().record(event({ id: 'a', at: 1, sessionId: 's1' }))
    const partialize = useActivityTimeline.persist.getOptions().partialize!
    const persisted = partialize(useActivityTimeline.getState()) as Record<string, unknown>
    expect(Object.keys(persisted)).toEqual(['logs'])
  })
})
