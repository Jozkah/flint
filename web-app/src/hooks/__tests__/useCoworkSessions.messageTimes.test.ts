import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

const msg = (id: string, metadata?: Record<string, unknown>) =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text: id }], metadata }) as UIMessage

const timeOf = (sid: string, mid: string) =>
  (
    useCoworkSessions
      .getState()
      .sessions.find((s) => s.id === sid)
      ?.messages.find((m) => m.id === mid)?.metadata as { createdAt?: unknown }
  )?.createdAt

// Live test 10: after a restart every message without a stored time showed
// the time it was rendered again. The time is stamped when a message is
// first stored and kept from then on.
describe('message times survive a restart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T19:48:00Z'))
    useCoworkSessions.setState({ sessions: [], currentId: null })
  })
  afterEach(() => vi.useRealTimers())

  it('stamps a message without a time when it is stored, and keeps that stamp', () => {
    const sid = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().setMessages(sid, [msg('a')])
    const first = timeOf(sid, 'a')
    expect(typeof first).toBe('number')
    expect(new Date(first as number).toISOString()).toBe('2026-10-18T19:48:00.000Z')

    vi.setSystemTime(new Date('2026-10-18T20:36:00Z'))
    // The same message handed back without its metadata (a reload, a stream
    // update) keeps the time it was first stored with.
    useCoworkSessions.getState().setMessages(sid, [msg('a'), msg('b')])
    expect(timeOf(sid, 'a')).toEqual(first)
    expect(new Date(timeOf(sid, 'b') as string).toISOString()).toBe(
      '2026-10-18T20:36:00.000Z'
    )
  })

  it('leaves a time a message already has alone', () => {
    const sid = useCoworkSessions.getState().createSession()
    const at = new Date('2026-10-17T08:00:00Z')
    useCoworkSessions.getState().setMessages(sid, [msg('a', { createdAt: at })])
    expect(timeOf(sid, 'a')).toEqual(at)
  })

  // The run's own commit is how almost every message reaches the store, and it
  // used to write the run's messages as they were, unstamped (live final test).
  it('stamps and keeps times when a run commits its messages', () => {
    const sid = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().commitTurns(sid, [], [msg('a')], [])
    const first = timeOf(sid, 'a')
    expect(typeof first).toBe('number')
    expect(new Date(first as number).toISOString()).toBe('2026-10-18T19:48:00.000Z')

    vi.setSystemTime(new Date('2026-10-18T20:36:00Z'))
    useCoworkSessions.getState().commitTurns(sid, [], [msg('a'), msg('b')], [])
    expect(timeOf(sid, 'a')).toEqual(first)
    expect(new Date(timeOf(sid, 'b') as string).toISOString()).toBe(
      '2026-10-18T20:36:00.000Z'
    )
  })
})
