import { describe, expect, it } from 'vitest'
import { contextUsage } from '../contextUsage'

describe('contextUsage', () => {
  it('puts 25.5K of a 262144 window at a tenth', () => {
    const u = contextUsage(25_500, 262_144)
    expect(u.known).toBe(true)
    expect(u.pct).toBeCloseTo(9.73, 1)
    expect(u.label).toBe('25.5K / 262.1K (10%)')
    expect(u.tier).toBe('ok')
  })

  it('puts 100K of a 200K window at half', () => {
    const u = contextUsage(100_000, 200_000)
    expect(u.fraction).toBe(0.5)
    expect(u.share(100_000)).toBe(0.5)
    expect(u.label).toBe('100.0K / 200.0K (50%)')
  })

  it('warns near the limit and calls it over at the limit', () => {
    expect(contextUsage(180_000, 200_000).tier).toBe('warn')
    expect(contextUsage(200_000, 200_000).tier).toBe('over')
  })

  it.each([undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats a window of %s as unknown, with no fraction',
    (window) => {
      const u = contextUsage(25_500, window)
      expect(u.known).toBe(false)
      expect(u.window).toBeNull()
      expect(u.fraction).toBe(0)
      expect(u.share(25_500)).toBe(0)
      expect(u.thresholdShare).toBeNull()
      expect(u.label).toBe('25.5K tokens (window unknown)')
    }
  )

  it('reads a bad used figure as zero', () => {
    expect(contextUsage(Number.NaN, 1000).fraction).toBe(0)
    expect(contextUsage(-3, 1000).used).toBe(0)
  })

  it('clamps usage past the window, and scales segments to what is in use', () => {
    const u = contextUsage(300_000, 200_000)
    expect(u.over).toBe(true)
    expect(u.fraction).toBe(1)
    expect(u.pct).toBe(100)
    expect(u.share(150_000)).toBeCloseTo(0.5, 5)
    expect(u.share(300_000)).toBe(1)
  })

  it('splits segments in proportion to each other on the window scale', () => {
    const u = contextUsage(25_500, 262_144)
    expect(u.share(20_000) + u.share(5_500)).toBeCloseTo(u.fraction, 6)
    expect(u.share(20_000) / u.share(5_500)).toBeCloseTo(20_000 / 5_500, 6)
  })

  it('places the compaction threshold on the same scale', () => {
    expect(contextUsage(1000, 200_000, 20_000).thresholdShare).toBeCloseTo(0.9, 6)
    expect(contextUsage(1000, 200_000, 0).thresholdShare).toBeNull()
    expect(contextUsage(300_000, 200_000, 20_000).thresholdShare).toBeCloseTo(
      180_000 / 300_000,
      6
    )
  })

  it('shows a sliver as under one percent rather than zero', () => {
    expect(contextUsage(100, 262_144).label).toBe('100 / 262.1K (<1%)')
    expect(contextUsage(0, 262_144).label).toBe('0 / 262.1K (0%)')
  })
})
