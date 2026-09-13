import { describe, expect, it } from 'vitest'
import { DEFAULT_COMPACTION_POLICY, effectiveReserve, getCompactionPolicy, outputHeadroom } from '../compactionPolicy'

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
})
