import { describe, it, expect } from 'vitest'
import { isGpuCrashDuringLoad, shouldRetryLoadOnCpu } from './cpuFallback'

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

describe('isGpuCrashDuringLoad', () => {
  const crash = {
    code: 'ENGINE_STOPPED',
    details:
      'exit code 0xC0000005 (access violation). Last output: ggml_vulkan: Found 1 Vulkan devices',
  }

  it('offers the CPU for an access violation during load', () => {
    expect(isGpuCrashDuringLoad({ error: crash, alreadyOnCpu: false })).toBe(true)
  })

  it('recognizes SIGSEGV and a lost Vulkan device', () => {
    for (const details of [
      'signal 11 (SIGSEGV: segmentation fault)',
      'vk::Queue::submit: ErrorDeviceLost',
    ]) {
      expect(
        isGpuCrashDuringLoad({
          error: { code: 'ENGINE_STOPPED', details },
          alreadyOnCpu: false,
        })
      ).toBe(true)
    }
  })

  it('does not offer it twice, on a CPU-only engine, or for other failures', () => {
    expect(isGpuCrashDuringLoad({ error: crash, alreadyOnCpu: true })).toBe(false)
    expect(
      isGpuCrashDuringLoad({ error: crash, alreadyOnCpu: false, configuredDevice: 'none' })
    ).toBe(false)
    expect(
      isGpuCrashDuringLoad({
        error: { code: 'OUT_OF_MEMORY', details: 'access violation' },
        alreadyOnCpu: false,
      })
    ).toBe(false)
    expect(
      isGpuCrashDuringLoad({
        error: { code: 'ENGINE_STOPPED', details: 'exit code 1' },
        alreadyOnCpu: false,
      })
    ).toBe(false)
  })

  it('leaves CPU_NOT_SUPPORTED to the automatic retry', () => {
    const cpu = { code: 'CPU_NOT_SUPPORTED', details: 'access violation' }
    expect(isGpuCrashDuringLoad({ error: cpu, alreadyOnCpu: false })).toBe(false)
    expect(shouldRetryLoadOnCpu({ error: cpu, alreadyRetried: false })).toBe(true)
  })
})
