import { describe, it, expect } from 'vitest'
import {
  detectFromEnv,
  isPerformanceMode,
  resolvePerfReduced,
  streamingThrottleMs,
} from '@/lib/perfMode'

describe('performance mode detection', () => {
  it('reduces on few cores, little memory, slow frames, reduced motion or data saver', () => {
    expect(detectFromEnv({ hardwareConcurrency: 4, deviceMemory: 16 })).toMatchObject({
      reduced: true,
      reason: 'cores',
      cores: 4,
    })
    expect(detectFromEnv({ hardwareConcurrency: 8, deviceMemory: 4 })).toMatchObject({
      reduced: true,
      reason: 'memory',
    })
    expect(detectFromEnv({ hardwareConcurrency: 8 }, 33)).toMatchObject({
      reduced: true,
      reason: 'frames',
    })
    expect(
      detectFromEnv({ hardwareConcurrency: 8, prefersReducedMotion: true })
    ).toMatchObject({ reduced: true, reason: 'motion' })
    expect(detectFromEnv({ hardwareConcurrency: 8, saveData: true })).toMatchObject({
      reduced: true,
      reason: 'data',
    })
  })

  it('stays full on a capable machine, including when a value is unknown', () => {
    expect(detectFromEnv({ hardwareConcurrency: 16, deviceMemory: 8 }, 16.7).reduced).toBe(false)
    expect(detectFromEnv({}).reduced).toBe(false)
  })

  it('the setting overrides Auto both ways', () => {
    const slow = detectFromEnv({ hardwareConcurrency: 2 })
    const fast = detectFromEnv({ hardwareConcurrency: 16 })
    expect(resolvePerfReduced('auto', slow)).toBe(true)
    expect(resolvePerfReduced('auto', fast)).toBe(false)
    expect(resolvePerfReduced('full', slow)).toBe(false)
    expect(resolvePerfReduced('reduced', fast)).toBe(true)
  })

  it('validates stored values and slows streaming updates when reduced', () => {
    expect(isPerformanceMode('auto')).toBe(true)
    expect(isPerformanceMode('fast')).toBe(false)
    expect(streamingThrottleMs(false)).toBe(50)
    expect(streamingThrottleMs(true)).toBe(100)
  })
})
