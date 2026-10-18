import { describe, it, expect } from 'vitest'
import { shouldRetryLoadOnCpu } from './cpuFallback'

describe('shouldRetryLoadOnCpu', () => {
  const cpuError = { code: 'CPU_NOT_SUPPORTED', message: 'x' }

  it('retries a CPU-not-supported crash once', () => {
    expect(shouldRetryLoadOnCpu({ error: cpuError, alreadyRetried: false })).toBe(true)
    expect(shouldRetryLoadOnCpu({ error: cpuError, alreadyRetried: true })).toBe(false)
  })

  it('does not retry other failures', () => {
    for (const code of ['OUT_OF_MEMORY', 'MODEL_LOAD_FAILED', 'ENGINE_STOPPED']) {
      expect(
        shouldRetryLoadOnCpu({ error: { code }, alreadyRetried: false })
      ).toBe(false)
    }
    expect(shouldRetryLoadOnCpu({ error: 'boom', alreadyRetried: false })).toBe(false)
    expect(shouldRetryLoadOnCpu({ error: null, alreadyRetried: false })).toBe(false)
  })

  it('does not retry when the engine is already set to CPU only', () => {
    expect(
      shouldRetryLoadOnCpu({
        error: cpuError,
        alreadyRetried: false,
        configuredDevice: 'none',
      })
    ).toBe(false)
    expect(
      shouldRetryLoadOnCpu({
        error: cpuError,
        alreadyRetried: false,
        configuredDevice: 'Vulkan0',
      })
    ).toBe(true)
  })
})
