import { describe, expect, it } from 'vitest'
import {
  formatEta,
  secondsRemaining,
  startSpeedSample,
  updateSpeedSample,
} from '@/lib/downloadSpeed'

const MB = 1024 * 1024

describe('updateSpeedSample', () => {
  it('measures the first interval directly', () => {
    const s = updateSpeedSample(startSpeedSample(0, 0), 10 * MB, 1000)
    expect(s.bytesPerSecond).toBe(10 * MB)
  })

  it('smooths later intervals instead of jumping', () => {
    const first = updateSpeedSample(startSpeedSample(0, 0), 10 * MB, 1000)
    const second = updateSpeedSample(first, 10 * MB + 40 * MB, 2000)
    // 40 MB/s instantly, but the average only moves a quarter of the way.
    expect(second.bytesPerSecond).toBeCloseTo(10 * MB * 0.75 + 40 * MB * 0.25)
  })

  it('lets a stall pull the speed down', () => {
    const fast = updateSpeedSample(startSpeedSample(0, 0), 50 * MB, 1000)
    const stalled = updateSpeedSample(fast, 50 * MB, 3000)
    expect(stalled.bytesPerSecond).toBeLessThan(fast.bytesPerSecond)
  })

  it('ignores an interval too short to measure, and restarts if progress goes backwards', () => {
    const base = startSpeedSample(5 * MB, 1000)
    expect(updateSpeedSample(base, 6 * MB, 1100)).toBe(base)
    expect(updateSpeedSample(base, 1 * MB, 2000).downloaded).toBe(1 * MB)
  })
})

describe('secondsRemaining', () => {
  it('divides what is left by the speed', () => {
    expect(secondsRemaining(20 * MB, 100 * MB, 10 * MB)).toBe(8)
  })

  it('is null without a total, a speed, or anything left', () => {
    expect(secondsRemaining(1, undefined, 5)).toBeNull()
    expect(secondsRemaining(1, 10, 0)).toBeNull()
    expect(secondsRemaining(10, 10, 5)).toBeNull()
  })
})

describe('formatEta', () => {
  it('is coarse', () => {
    expect(formatEta(0)).toBe('1 s')
    expect(formatEta(45)).toBe('45 s')
    expect(formatEta(600)).toBe('10 min')
    expect(formatEta(3600)).toBe('1 h')
    expect(formatEta(4800)).toBe('1 h 20 min')
  })
})
