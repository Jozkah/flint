import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACTION_POLICY,
  effectiveReserve,
  getCompactionPolicy,
  outputHeadroom,
  replyReserve,
} from '../compactionPolicy'

describe('compactionPolicy (AH-076)', () => {
  it('uses the same defaults the backend does outside the desktop', async () => {
    const p = await getCompactionPolicy()
    expect(p).toEqual(DEFAULT_COMPACTION_POLICY)
    expect([p.reserveTokens, p.keepRecent, p.summaryMaxTokens, p.strategy, p.auto]).toEqual([
      16384, 8, 512, 'summarize', true,
    ])
  })

  it('keeps the larger of the reserve and the model output cap free', () => {
    expect(outputHeadroom(100_000, 2048, { reserveTokens: 16384 })).toBe(16384)
    expect(outputHeadroom(100_000, 32_000, { reserveTokens: 16384 })).toBe(32_000)
  })

  it('never reserves more than a quarter of a small window', () => {
    expect(effectiveReserve(12_000, { reserveTokens: 16384 })).toBe(3000)
    expect(effectiveReserve(128_000, { reserveTokens: 16384 })).toBe(16384)
  })

  it('reserves only the user cap, else min(2048, 10%), for a local model', () => {
    const policy = { reserveTokens: 16384 }
    // The user's case: a 32K local Gemma kept 8192 free and refused 25K prompts.
    expect(replyReserve(32_768, undefined, policy, true)).toBe(2048)
    expect(replyReserve(8_192, undefined, policy, true)).toBe(819)
    expect(replyReserve(32_768, 1024, policy, true)).toBe(1024)
    expect(replyReserve(32_768, 0, policy, true)).toBe(2048)
  })

  it('keeps the cloud headroom unchanged', () => {
    const policy = { reserveTokens: 16384 }
    expect(replyReserve(200_000, undefined, policy, false)).toBe(outputHeadroom(200_000, 2048, policy))
    expect(replyReserve(32_768, 4096, policy, false)).toBe(8192)
  })
})
