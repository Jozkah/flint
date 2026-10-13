import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import { addToReplySpeed, earlierTokenSpeed } from '../replyTokenSpeed'

const asst = (tokenSpeed: unknown): UIMessage =>
  ({ id: 'a', role: 'assistant', parts: [], metadata: { tokenSpeed } }) as UIMessage
const user = { id: 'u', role: 'user', parts: [] } as unknown as UIMessage

describe('addToReplySpeed', () => {
  it('weights the speed by time, not by averaging', () => {
    const out = addToReplySpeed(
      { tokenSpeed: 10, tokenCount: 100, durationMs: 10_000 },
      { tokenSpeed: 50, tokenCount: 5_000, durationMs: 100_000 }
    )
    expect(out.tokenCount).toBe(5_100)
    expect(out.durationMs).toBe(110_000)
    expect(Math.round(out.tokenSpeed * 100) / 100).toBe(46.36)
  })

  it('counts earlier tokens with no measured speed without guessing time', () => {
    const out = addToReplySpeed(
      { tokenSpeed: 0, tokenCount: 50, durationMs: 0 },
      { tokenSpeed: 50, tokenCount: 100, durationMs: 2_000 }
    )
    expect(out.tokenCount).toBe(150)
    expect(out.tokenSpeed).toBe(50)
  })

  it('is the call itself for a new reply', () => {
    const call = { tokenSpeed: 50, tokenCount: 500, durationMs: 10_000 }
    expect(addToReplySpeed(undefined, call)).toBe(call)
  })
})

describe('earlierTokenSpeed', () => {
  it('reads the reply a request continues', () => {
    expect(
      earlierTokenSpeed([
        user,
        asst({ tokenSpeed: 10, tokenCount: 100, durationMs: 10_000 }),
      ])
    ).toEqual({ tokenSpeed: 10, tokenCount: 100, durationMs: 10_000 })
  })

  it('starts from nothing when the last message is the user', () => {
    expect(
      earlierTokenSpeed([asst({ tokenSpeed: 10, tokenCount: 100 }), user])
    ).toBeUndefined()
  })
})
