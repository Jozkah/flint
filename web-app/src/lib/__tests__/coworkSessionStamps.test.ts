import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { sanitizeSender, stamped, withStoredTimes } from '../coworkSessionStamps'

const msg = (id: string, createdAt?: number): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [],
    ...(createdAt === undefined ? {} : { metadata: { createdAt } }),
  }) as UIMessage

describe('coworkSessionStamps', () => {
  it('stamps only rows without a time, and returns the same array when all have one', () => {
    const done = [{ role: 'user', at: 5 }] as never
    expect(stamped(done)).toBe(done)
    const out = stamped([{ role: 'user' }, { role: 'user', at: 5 }] as never) as {
      at: number
    }[]
    expect(out[0].at).toBeGreaterThan(5)
    expect(out[1].at).toBe(5)
  })

  it('gives an unstamped message the time it had before, else the given one', () => {
    const out = withStoredTimes([msg('a', 10)], [msg('a'), msg('b'), msg('c', 3)], 99)
    const times = out.map((m) => (m.metadata as { createdAt: number }).createdAt)
    expect(times).toEqual([10, 99, 3])
  })

  it('keeps only the sender fields the queue defines', () => {
    const out = sanitizeSender({
      sessionId: 's',
      displayName: 'd',
      messageId: 'm',
      depth: 1,
      extra: 'x',
    } as never)
    expect(out).toEqual({
      sessionId: 's',
      displayName: 'd',
      messageId: 'm',
      replyTo: null,
      depth: 1,
    })
  })
})
