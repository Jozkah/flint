import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'
import {
  convertThreadMessageToUIMessage,
  convertUIMessageToThreadMessage,
} from '../messages'
import { earlierCreatedAt, toMs } from '../messageTime'
import { messagesFromJournal } from '../rooms/recovery'
import type { RoomJournalRecord } from '../rooms/types'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { resetToolTimingLog, timingFor } from '../toolTimingLog'

const THEN = new Date(2024, 4, 6, 21, 49).getTime()

const stored = (over: Partial<ThreadMessage> = {}): ThreadMessage =>
  ({
    id: 'm1',
    object: 'thread.message',
    thread_id: 't1',
    role: 'assistant',
    content: [{ type: ContentType.Text, text: { value: 'hi', annotations: [] } }],
    status: MessageStatus.Ready,
    created_at: THEN,
    completed_at: THEN + 5000,
    ...over,
  }) as ThreadMessage

describe('message times survive a thread switch (Chat)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2030, 0, 1))
  })
  afterEach(() => vi.useRealTimers())

  it('thread -> ui -> thread keeps created_at, not the time of the round trip', () => {
    const ui = convertThreadMessageToUIMessage(stored())
    expect((ui.metadata as { createdAt: Date }).createdAt.getTime()).toBe(THEN)
    expect(convertUIMessageToThreadMessage(ui, 't1').created_at).toBe(THEN)
  })

  it('a time that came back from a persisted store as a number or string is kept', () => {
    for (const createdAt of [THEN, new Date(THEN).toISOString()]) {
      const back = convertUIMessageToThreadMessage(
        { id: 'x', role: 'user', parts: [], metadata: { createdAt } } as never,
        't1'
      )
      expect(back.created_at).toBe(THEN)
    }
  })

  it('a stored message with no time yields no time, never "now"', () => {
    const ui = convertThreadMessageToUIMessage(
      stored({ created_at: undefined as unknown as number })
    )
    expect((ui.metadata as { createdAt?: unknown }).createdAt).toBeUndefined()
  })

  it('a reply continued after a tool keeps the time it began with', () => {
    expect(
      earlierCreatedAt([
        { role: 'user' },
        { role: 'assistant', metadata: { createdAt: THEN } },
      ])
    ).toBe(THEN)
    expect(earlierCreatedAt([{ role: 'user', metadata: { createdAt: THEN } }])).toBeUndefined()
    expect(toMs('not a date')).toBeUndefined()
  })
})

describe('tool durations survive a thread switch (Chat and Cowork)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0))
    resetToolTimingLog()
    useToolCallRuntime.getState().reset()
  })
  afterEach(() => {
    resetToolTimingLog()
    vi.useRealTimers()
  })

  it('shows the same start and end after the runtime store is cleared on leaving', () => {
    const rt = () => useToolCallRuntime.getState()
    rt().enqueue(['call-1'])
    rt().markRunning('call-1')
    const startedAt = Date.now()
    vi.advanceTimersByTime(13_600)
    rt().markSettled('call-1')
    const live = timingFor(rt().timings, 'call-1')
    expect(live).toEqual({ startedAt, endedAt: startedAt + 13_600 })

    // Leaving the conversation wipes the live store.
    rt().reset()
    expect(rt().timings).toEqual({})
    expect(timingFor(rt().timings, 'call-1')).toEqual(live)
  })

  it('survives a reload: the log is read back from storage', async () => {
    const rt = useToolCallRuntime.getState()
    rt.enqueue(['call-2'])
    rt.markRunning('call-2')
    const startedAt = Date.now()
    vi.advanceTimersByTime(5000)
    rt.markSettled('call-2')
    vi.advanceTimersByTime(1000) // the debounced write
    vi.resetModules()
    const fresh = await import('../toolTimingLog')
    expect(fresh.loggedToolTiming('call-2')).toEqual({
      startedAt,
      endedAt: startedAt + 5000,
    })
  })

  it('an old call that never stored a timing has none, not zero', () => {
    expect(timingFor({}, 'never-timed')).toBeUndefined()
    useToolCallRuntime.getState().enqueue(['queued'])
    useToolCallRuntime.getState().settleRemaining(undefined)
    expect(timingFor(useToolCallRuntime.getState().timings, 'queued')?.startedAt).toBeUndefined()
  })
})

describe('message times survive reopening a room (Rooms)', () => {
  it('the transcript rebuilt from the journal keeps each stored time and duration', () => {
    const author = { kind: 'participant' as const, participantId: 'p', name: 'A' }
    const journal: RoomJournalRecord[] = [
      {
        type: 'message',
        message: {
          v: 1, id: 'r1', roomId: 'room', seq: 1, turnId: 't', author, to: { kind: 'room' },
          kind: 'speech', text: 'x', round: 1, createdAt: THEN, status: 'complete',
          compare: { durationMs: 13_600 },
        } as never,
      },
    ]
    const [m] = messagesFromJournal('room', JSON.parse(JSON.stringify(journal)))
    expect(m.createdAt).toBe(THEN)
    expect((m as { compare?: { durationMs: number } }).compare?.durationMs).toBe(13_600)
  })
})
