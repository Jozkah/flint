import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  readGgufMetadata: vi.fn().mockRejectedValue(new Error('no file')),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  i18n: { t: (key: string) => key },
}))

import { toast } from 'sonner'
import type { HardwareData } from '@/hooks/useHardware'
import { warnIfOverMetalBudget } from '@/lib/metalBudgetWarning'

const GIB = 1024 ** 3

const mac = (ramGib: number) =>
  ({
    os_type: 'macos',
    cpu: { arch: 'aarch64' },
    gpus: [],
    total_memory: ramGib * 1024,
  }) as unknown as HardwareData

const linux = (ramGib: number) =>
  ({
    os_type: 'linux',
    cpu: { arch: 'x86_64' },
    gpus: [],
    total_memory: ramGib * 1024,
  }) as unknown as HardwareData

const run = (hardware: HardwareData, sizeBytes: number, settings = {}) =>
  warnIfOverMetalBudget({
    modelId: 'm',
    hardware,
    settings: { ctx_size: 4096, ...settings },
    fetchModels: async () =>
      [{ id: 'm', providerId: 'llamacpp', sizeBytes }] as never,
  })

describe('warnIfOverMetalBudget', () => {
  beforeEach(() => vi.mocked(toast.warning).mockClear())

  it('warns before loading a model larger than the Metal working set', async () => {
    // 64 GB Mac: the GPU gets ~48 GB by default, the overall pool is larger.
    expect(await run(mac(64), 50 * GIB)).toBe(true)
    expect(toast.warning).toHaveBeenCalledWith(
      'model-fit:metalBudget.warning',
      expect.anything()
    )
  })

  it('stays quiet for a model that fits the Metal working set', async () => {
    expect(await run(mac(64), 20 * GIB)).toBe(false)
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('stays quiet when GPU layers are set to 0', async () => {
    expect(await run(mac(64), 50 * GIB, { n_gpu_layers: 0 })).toBe(false)
  })

  it('leaves other platforms unchanged', async () => {
    expect(await run(linux(64), 50 * GIB)).toBe(false)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
