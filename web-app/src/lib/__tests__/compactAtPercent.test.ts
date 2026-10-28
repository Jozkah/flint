import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPACTION_POLICY,
  clampCompactAtPercent,
  compactThresholdFor,
} from '@/lib/compactionPolicy'
import { DEFAULT_COMPACT_THRESHOLD, shouldCompact } from '@/lib/compaction'

const WINDOW = 100_000

describe('compact at N% of the context window', () => {
  it('defaults to automatic, so the built-in trigger is unchanged', () => {
    expect(DEFAULT_COMPACTION_POLICY.compactAtPercent).toBe(0)
    expect(compactThresholdFor(DEFAULT_COMPACTION_POLICY, DEFAULT_COMPACT_THRESHOLD)).toBe(
      DEFAULT_COMPACT_THRESHOLD
    )
    expect(compactThresholdFor(undefined, 0.8)).toBe(0.8)
    // 79% stays under the built-in 80% trigger with the default policy.
    expect(shouldCompact(79_000, WINDOW)).toBe(false)
    expect(shouldCompact(80_000, WINDOW)).toBe(true)
  })

  it('compacts at the chosen percentage', () => {
    const policy = { ...DEFAULT_COMPACTION_POLICY, compactAtPercent: 60 }
    expect(compactThresholdFor(policy, DEFAULT_COMPACT_THRESHOLD)).toBe(0.6)
    expect(shouldCompact(59_000, WINDOW, undefined, 0, policy)).toBe(false)
    expect(shouldCompact(60_000, WINDOW, undefined, 0, policy)).toBe(true)
    // An explicit threshold argument still wins.
    expect(shouldCompact(60_000, WINDOW, 0.8, 0, policy)).toBe(false)
  })

  it('clamps out-of-range values to 50-95 and keeps 0 as automatic', () => {
    expect(clampCompactAtPercent(0)).toBe(0)
    expect(clampCompactAtPercent(-5)).toBe(0)
    expect(clampCompactAtPercent(Number.NaN)).toBe(0)
    expect(clampCompactAtPercent(10)).toBe(50)
    expect(clampCompactAtPercent(99)).toBe(95)
    expect(clampCompactAtPercent(72.4)).toBe(72)
    const high = { ...DEFAULT_COMPACTION_POLICY, compactAtPercent: 100 }
    expect(compactThresholdFor(high, 0.8)).toBe(0.95)
  })
})
