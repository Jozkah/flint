import { describe, it, expect } from 'vitest'
import { createReasoningClock, thoughtSecondsFromMetadata } from '../reasoningClock'

describe('createReasoningClock', () => {
  it('times a reasoning block from its first part to the text that follows', () => {
    const c = createReasoningClock()
    c.observe('start', 0)
    c.observe('reasoning-start', 1000)
    c.observe('reasoning-delta', 2000)
    c.observe('reasoning-end', 4500)
    c.observe('text-delta', 5000)
    expect(c.totalMs(9000)).toBe(3500)
  })

  it('accumulates separate blocks and ignores time outside them', () => {
    const c = createReasoningClock()
    c.observe('reasoning-delta', 0)
    c.observe('tool-input-start', 2000)
    c.observe('reasoning-delta', 10_000)
    c.observe('finish', 11_000)
    expect(c.totalMs(20_000)).toBe(3000)
  })

  it('counts a block that is still open up to now', () => {
    const c = createReasoningClock()
    c.observe('reasoning-start', 100)
    expect(c.totalMs(1100)).toBe(1000)
  })

  it('works when the stream never announces reasoning-start', () => {
    const c = createReasoningClock()
    c.observe('reasoning-delta', 0)
    c.observe('reasoning-delta', 500)
    c.observe('finish', 1500)
    expect(c.totalMs(9999)).toBe(1500)
  })
})

describe('thoughtSecondsFromMetadata', () => {
  it('rounds up to whole seconds, at least one', () => {
    expect(thoughtSecondsFromMetadata({ reasoningMs: 1200 })).toBe(2)
    expect(thoughtSecondsFromMetadata({ reasoningMs: 40 })).toBe(1)
  })
  it('is undefined when nothing was stored', () => {
    expect(thoughtSecondsFromMetadata(undefined)).toBeUndefined()
    expect(thoughtSecondsFromMetadata({ reasoningMs: 0 })).toBeUndefined()
    expect(thoughtSecondsFromMetadata({ reasoningMs: 'x' })).toBeUndefined()
  })
})
