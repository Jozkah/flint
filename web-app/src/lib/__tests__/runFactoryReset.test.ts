import { describe, it, expect, vi } from 'vitest'
import { runFactoryReset, type FactoryResetDeps } from '../runFactoryReset'

function deps(over: Partial<FactoryResetDeps> = {}): FactoryResetDeps {
  return {
    getDataFolder: vi.fn().mockResolvedValue('/home/u/flint/data'),
    factoryReset: vi.fn().mockResolvedValue(undefined),
    pausePolling: vi.fn(),
    resumePolling: vi.fn(),
    onRootDir: vi.fn(),
    onError: vi.fn(),
    ...over,
  }
}

const opts = { keepAppData: false, keepModelsAndConfigs: false } as never

describe('runFactoryReset', () => {
  it('pauses polling and resets', async () => {
    const d = deps()
    await runFactoryReset(opts, d)
    expect(d.pausePolling).toHaveBeenCalled()
    expect(d.factoryReset).toHaveBeenCalledWith(opts)
    expect(d.resumePolling).not.toHaveBeenCalled()
  })

  it('resumes polling and reports when the reset fails (RTE-007)', async () => {
    const d = deps({ factoryReset: vi.fn().mockRejectedValue('boom') })
    await runFactoryReset(opts, d)
    expect(d.pausePolling).toHaveBeenCalled()
    expect(d.resumePolling).toHaveBeenCalled()
    expect(d.onError).toHaveBeenCalledWith('boom')
  })

  it('does not refuse when the folder has not loaded (F6m-025)', async () => {
    const d = deps({ getDataFolder: vi.fn().mockResolvedValue(undefined) })
    await runFactoryReset(opts, d)
    expect(d.onRootDir).not.toHaveBeenCalled()
    expect(d.factoryReset).toHaveBeenCalled()
  })

  it('refuses a root data folder', async () => {
    const d = deps({ getDataFolder: vi.fn().mockResolvedValue('/') })
    await runFactoryReset(opts, d)
    expect(d.onRootDir).toHaveBeenCalled()
    expect(d.factoryReset).not.toHaveBeenCalled()
    expect(d.pausePolling).not.toHaveBeenCalled()
  })
})
