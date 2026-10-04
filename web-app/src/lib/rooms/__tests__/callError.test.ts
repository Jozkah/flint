import { describe, it, expect } from 'vitest'
import { toRoomCallError } from '../callError'

describe('toRoomCallError: refusals for length', () => {
  it('is an overflow, carrying the window the server named', () => {
    const e = toRoomCallError(
      new Error("This model's maximum context length is 4096 tokens. However, you requested 9000 tokens")
    )
    expect(e.kind).toBe('overflow')
    expect(e.contextLimit).toBe(4096)
  })

  it('is an overflow with no limit when the server named none', () => {
    const e = toRoomCallError(new Error('prompt is too long'))
    expect(e).toMatchObject({ kind: 'overflow', contextLimit: null })
  })

  it('is not an overflow when "too many tokens" is throttling', () => {
    const e = toRoomCallError(
      Object.assign(new Error('Rate limit reached: too many tokens per minute'), { statusCode: 429 })
    )
    expect(e.kind).toBe('provider')
    expect(e.code).toBe('rate-limited:429')
  })

  it('is not an overflow for an unrelated failure', () => {
    expect(toRoomCallError(new Error('bad gateway')).kind).toBe('provider')
  })
})
