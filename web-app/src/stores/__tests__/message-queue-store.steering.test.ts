import { describe, it, expect, beforeEach } from 'vitest'
import { useMessageQueue } from '../message-queue-store'

const q = () => useMessageQueue.getState()
const msg = (id: string, text = id) => ({ id, text, createdAt: 1 })

describe('pending input held for a session (janhq/jan#8864)', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('hands over only what is ready, in the order it was typed', () => {
    q().enqueue('A', msg('1'))
    q().enqueue('A', msg('2'))
    q().enqueue('B', msg('b'))
    expect(q().takeReady('A').map((m) => m.id)).toEqual(['1', '2'])
    expect(q().getQueue('A')).toEqual([])
    // Another session's input is never taken.
    expect(q().getQueue('B').map((m) => m.id)).toEqual(['b'])
  })

  it('holds what a failed or stopped run did not deliver, instead of dropping or sending it', () => {
    q().enqueue('A', msg('1'))
    q().enqueue('A', msg('2'))
    q().holdQueue('A')
    expect(q().getQueue('A').every((m) => m.held)).toBe(true)
    // Held input is not handed to the next run or sent on its own.
    expect(q().takeReady('A')).toEqual([])
    expect(q().dequeueReady('A')).toBeUndefined()
    expect(q().getQueue('A')).toHaveLength(2)
  })

  it('releases one held message to be sent, and keeps the rest held', () => {
    q().enqueue('A', msg('1'))
    q().enqueue('A', msg('2'))
    q().holdQueue('A')
    q().release('A', '2')
    expect(q().dequeueReady('A')?.id).toBe('2')
    expect(q().getQueue('A').map((m) => [m.id, m.held])).toEqual([['1', true]])
  })

  it('restores input as held, never as ready to send', () => {
    q().restoreHeld('A', [msg('1'), msg('2')])
    expect(q().getQueue('A').every((m) => m.held)).toBe(true)
    // Idempotent: restoring twice does not duplicate.
    q().restoreHeld('A', [msg('1')])
    expect(q().getQueue('A')).toHaveLength(2)
  })
})
