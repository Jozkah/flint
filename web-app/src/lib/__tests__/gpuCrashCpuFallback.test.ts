import { beforeEach, describe, expect, it } from 'vitest'
import {
  answerGpuCrashCpuFallback,
  askCpuFallback,
  isCpuFallbackOffered,
  resetGpuCrashCpuFallback,
  useGpuCrashCpuFallback,
} from '../gpuCrashCpuFallback'

describe('gpuCrashCpuFallback', () => {
  beforeEach(() => resetGpuCrashCpuFallback())

  it('offers the CPU only for a load the extension marked', () => {
    expect(
      isCpuFallbackOffered({
        code: 'ENGINE_STOPPED',
        details: 'exit code 0xC0000005 (access violation)',
        cpu_fallback_offered: true,
      })
    ).toBe(true)
    // A mid-generation crash is reported as before, without the mark.
    expect(
      isCpuFallbackOffered({
        code: 'ENGINE_STOPPED',
        details: 'exit code 0xC0000005 (access violation)',
      })
    ).toBe(false)
    expect(isCpuFallbackOffered({ code: 'CPU_NOT_SUPPORTED' })).toBe(false)
    expect(isCpuFallbackOffered('boom')).toBe(false)
    expect(isCpuFallbackOffered(null)).toBe(false)
  })

  it('asks once per model and resolves with the answer', async () => {
    const first = askCpuFallback('m')
    expect(useGpuCrashCpuFallback.getState().request?.modelId).toBe('m')
    answerGpuCrashCpuFallback(true)
    await expect(first).resolves.toBe(true)
    expect(useGpuCrashCpuFallback.getState().request).toBeNull()

    await expect(askCpuFallback('m')).resolves.toBe(false)
    expect(useGpuCrashCpuFallback.getState().request).toBeNull()
  })

  it('a dismissed question answers no', async () => {
    const p = askCpuFallback('x')
    answerGpuCrashCpuFallback(false)
    await expect(p).resolves.toBe(false)
  })
})
