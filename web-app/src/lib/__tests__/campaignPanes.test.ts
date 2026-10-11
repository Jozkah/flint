import { describe, expect, it } from 'vitest'
import { accountPanes, type PaneLike } from '../campaignPanes'

const pane = (id: string, refId?: string, kind = 'cowork'): PaneLike => ({
  id,
  kind,
  refId,
})

const base = (over: Partial<Parameters<typeof accountPanes>[0]> = {}) => ({
  panes: [] as PaneLike[],
  maxPanes: 4,
  liveSessions: new Set<string>(),
  isTaskSession: (s: string) => s.startsWith('task-'),
  hasQueued: () => false,
  ...over,
})

describe('campaign pane accounting', () => {
  it('counts room, empty panes and nothing else when no task is idle', () => {
    expect(accountPanes(base()).free).toBe(3)
    expect(
      accountPanes(
        base({ panes: [pane('p1', 'chat-1', 'chat'), pane('p2')] })
      ).free
    ).toBe(1 + 1)
  })

  it('does not count a settled task pane against new work', () => {
    const r = accountPanes(
      base({
        maxPanes: 3,
        panes: [pane('p1', 'task-done-1'), pane('p2', 'task-done-2')],
      })
    )
    expect(r.free).toBe(2)
    expect(r.recyclable).toEqual(['p1', 'p2'])
  })

  it('keeps a task with a live run, a pending seed or a start in flight', () => {
    const r = accountPanes(
      base({
        maxPanes: 4,
        panes: [pane('p1', 'task-live'), pane('p2', 'task-seed'), pane('p3', 'task-busy')],
        liveSessions: new Set(['task-live']),
        hasQueued: (s) => s === 'task-seed',
        busy: new Set(['task-busy']),
      })
    )
    expect(r.recyclable).toEqual([])
    expect(r.free).toBe(0)
  })

  it('never recycles the user\'s own sessions and chats', () => {
    const r = accountPanes(
      base({
        maxPanes: 3,
        panes: [pane('p1', 'my-session'), pane('p2', 'thread', 'chat')],
      })
    )
    expect(r.recyclable).toEqual([])
    expect(r.free).toBe(0)
  })

  it('re-queued task and a second campaign still find a pane', () => {
    // Campaign A: t1 finished, t2 re-queued (own pane shown, idle).
    // Campaign B: its first task is waiting for a pane.
    const r = accountPanes(
      base({
        maxPanes: 3,
        panes: [pane('p1', 'task-a-1'), pane('p2', 'task-a-2')],
      })
    )
    expect(r.free).toBe(2)
  })
})
