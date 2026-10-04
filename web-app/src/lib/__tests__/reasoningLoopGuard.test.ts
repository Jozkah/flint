import { ReasoningLoopGuard } from '../reasoningLoopGuard'

describe('ReasoningLoopGuard', () => {
  it('stops a long repeated reasoning sequence across stream chunks', () => {
    const guard = new ReasoningLoopGuard()
    const phrase = '17892, 5228, 12804, 5228, '
    let repeated = false
    for (const chunk of (phrase.repeat(30)).match(/.{1,13}/g) ?? []) {
      repeated = guard.add(chunk) || repeated
    }
    expect(repeated).toBe(true)
  })

  it('allows reasoning with changing content', () => {
    const guard = new ReasoningLoopGuard()
    for (let i = 0; i < 100; i++) {
      expect(guard.add(`Step ${i}: inspect distinct evidence ${i * i}. `)).toBe(false)
    }
  })
})
