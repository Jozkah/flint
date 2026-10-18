import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  heldMailOf,
  summarizeHeldMail,
  useHeldMailCount,
  useHeldMailSummary,
  useWaitingOnUser,
} from '../useHeldMail'
import { useMessageQueue, type QueuedMessage } from '@/stores/message-queue-store'

const mail = (id: string, at: number, name = 'Alpha'): QueuedMessage => ({
  id,
  text: id,
  createdAt: at,
  held: true,
  from: { sessionId: 'S1', displayName: name, messageId: id, depth: 0 },
})

describe('held mail', () => {
  beforeEach(() => {
    useMessageQueue.setState({ queues: {} })
  })

  it('lists only held mail, oldest first', () => {
    const typed: QueuedMessage = { id: 't', text: 't', createdAt: 0, held: true }
    const ready = { ...mail('r', 1), held: false }
    expect(heldMailOf([mail('b', 5), typed, ready, mail('a', 2)]).map((m) => m.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('summarizes each session with the latest sender', () => {
    expect(
      summarizeHeldMail({
        B: [mail('1', 1, 'Alpha'), mail('2', 2, 'Charlie')],
        C: [],
      })
    ).toEqual([{ sessionId: 'B', count: 2, from: 'Charlie' }])
  })

  it('counts per session and marks the session as waiting on the user', () => {
    const count = renderHook(() => useHeldMailCount('B'))
    const waiting = renderHook(() => useWaitingOnUser('B'))
    const summary = renderHook(() => useHeldMailSummary())
    expect(count.result.current).toBe(0)
    expect(waiting.result.current).toBe(false)
    act(() => {
      useMessageQueue.getState().enqueue('B', mail('m1', 1))
    })
    expect(count.result.current).toBe(1)
    expect(waiting.result.current).toBe(true)
    expect(summary.result.current).toEqual([{ sessionId: 'B', count: 1, from: 'Alpha' }])
    // A stable result between renders with nothing changed.
    const before = summary.result.current
    summary.rerender()
    expect(summary.result.current).toBe(before)
  })
})
