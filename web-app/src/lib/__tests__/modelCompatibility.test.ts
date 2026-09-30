import { describe, it, expect } from 'vitest'
import type { HardwareData } from '@/hooks/useHardware'
import {
  assessModelFit,
  DEFAULT_CTX_LENGTH,
  DISCRETE_VRAM_RESERVE_BYTES,
  estimateKvCacheBytes,
  estimateModelFit,
  isAppleSilicon,
  kvArchitectureFromGguf,
  kvCacheBytesFromArchitecture,
  parseFileSize,
  SYSTEM_RESERVE_BYTES,
  UNIFIED_SYSTEM_RESERVE_BYTES,
} from '../modelCompatibility'

const GB = 1024 ** 3

const baseHardware = (overrides: Partial<HardwareData> = {}): HardwareData => ({
  cpu: { arch: 'x86_64', core_count: 8, extensions: [], name: 'CPU', usage: 0 },
  gpus: [],
  os_type: 'linux',
  os_name: 'linux',
  total_memory: 16 * 1024,
  ...overrides,
})

const appleSilicon = (totalMemoryGib: number): HardwareData =>
  baseHardware({
    cpu: { arch: 'aarch64', core_count: 10, extensions: [], name: 'M2', usage: 0 },
    os_type: 'macos',
    total_memory: totalMemoryGib * 1024,
  })

const withDiscreteGpu = (
  ramGib: number,
  vramGib: number
): HardwareData =>
  baseHardware({
    total_memory: ramGib * 1024,
    gpus: [
      {
        name: 'GPU',
        total_memory: vramGib * 1024,
        vendor: 'nvidia',
        uuid: '0',
        driver_version: '',
        nvidia_info: { index: 0, compute_capability: '8.0' },
        vulkan_info: {
          index: 0,
          device_id: 0,
          device_type: 'discrete',
          api_version: '',
        },
      },
    ],
  })

describe('parseFileSize', () => {
  it('parses common decimal units', () => {
    expect(parseFileSize('4.7 GB')).toBeCloseTo(4.7 * 1000 ** 3)
    expect(parseFileSize('158 MB')).toBeCloseTo(158 * 1000 ** 2)
    expect(parseFileSize('2.5GB')).toBeCloseTo(2.5 * 1000 ** 3)
  })

  it('parses binary units distinctly from decimal', () => {
    expect(parseFileSize('1 GiB')).toBe(1024 ** 3)
    expect(parseFileSize('1 GB')).toBe(1000 ** 3)
  })

  it('returns null for unparseable input', () => {
    expect(parseFileSize('')).toBeNull()
    expect(parseFileSize(undefined)).toBeNull()
    expect(parseFileSize(null)).toBeNull()
    expect(parseFileSize('not a size')).toBeNull()
    expect(parseFileSize('4.7 ZB')).toBeNull()
  })

  it('accepts numbers as bytes', () => {
    expect(parseFileSize(5_000_000)).toBe(5_000_000)
    expect(parseFileSize(-1)).toBeNull()
  })
})

describe('estimateKvCacheBytes', () => {
  it('scales linearly with context length', () => {
    const base = estimateKvCacheBytes(10 * GB, 4096)
    expect(estimateKvCacheBytes(10 * GB, 8192)).toBeCloseTo(base * 2)
    expect(estimateKvCacheBytes(10 * GB, 2048)).toBeCloseTo(base * 0.5)
  })

  it('uses 10% of file size at the baseline context', () => {
    expect(estimateKvCacheBytes(10 * GB, 4096)).toBeCloseTo(GB)
  })

  it('falls back to default ctx when ctx is non-positive', () => {
    expect(estimateKvCacheBytes(10 * GB, 0)).toBeCloseTo(
      estimateKvCacheBytes(10 * GB, DEFAULT_CTX_LENGTH)
    )
  })

  it('returns 0 for invalid file size', () => {
    expect(estimateKvCacheBytes(0)).toBe(0)
    expect(estimateKvCacheBytes(-1)).toBe(0)
    expect(estimateKvCacheBytes(NaN)).toBe(0)
  })
})

describe('isAppleSilicon', () => {
  it('detects macOS + aarch64 + no discrete GPU', () => {
    expect(isAppleSilicon(appleSilicon(16))).toBe(true)
  })

  it('rejects when a discrete GPU is present', () => {
    const hw = appleSilicon(16)
    expect(isAppleSilicon({ ...hw, gpus: withDiscreteGpu(16, 8).gpus })).toBe(false)
  })

  it('rejects Intel Macs', () => {
    expect(
      isAppleSilicon({ ...appleSilicon(16), cpu: { ...appleSilicon(16).cpu, arch: 'x86_64' } })
    ).toBe(false)
  })
})

describe('estimateModelFit', () => {
  it('returns unknown when file size cannot be determined', () => {
    expect(estimateModelFit(null, DEFAULT_CTX_LENGTH, appleSilicon(16))).toBe('unknown')
    expect(estimateModelFit(0, DEFAULT_CTX_LENGTH, appleSilicon(16))).toBe('unknown')
  })

  it('returns unknown when hardware has not been probed', () => {
    expect(
      estimateModelFit(4 * GB, DEFAULT_CTX_LENGTH, baseHardware({ total_memory: 0 }))
    ).toBe('unknown')
  })

  describe('apple silicon', () => {
    it('greens a small model on a 16 GiB M-series', () => {
      expect(estimateModelFit(4 * GB, DEFAULT_CTX_LENGTH, appleSilicon(16))).toBe('green')
    })

    it('reds a model that exceeds usable unified memory', () => {
      expect(estimateModelFit(13 * GB, DEFAULT_CTX_LENGTH, appleSilicon(16))).toBe('red')
    })

    it('yellows a model that fits but leaves <15% headroom', () => {
      // 16 GiB → usable ≈ 11.9 GiB; comfortable threshold ≈ 10.1 GiB.
      // 9.5 GiB file × 1.2 (ctx overhead) ≈ 11.4 GiB required → YELLOW band.
      expect(estimateModelFit(9.5 * GB, DEFAULT_CTX_LENGTH, appleSilicon(16))).toBe('yellow')
    })
  })

  describe('discrete GPU', () => {
    it('greens a model that fits entirely in usable VRAM', () => {
      expect(
        estimateModelFit(4 * GB, DEFAULT_CTX_LENGTH, withDiscreteGpu(32, 16))
      ).toBe('green')
    })

    it('yellows a model that spills from VRAM into system RAM', () => {
      expect(
        estimateModelFit(10 * GB, DEFAULT_CTX_LENGTH, withDiscreteGpu(32, 8))
      ).toBe('yellow')
    })

    it('reds a model larger than combined usable RAM+VRAM', () => {
      expect(
        estimateModelFit(40 * GB, DEFAULT_CTX_LENGTH, withDiscreteGpu(16, 8))
      ).toBe('red')
    })
  })

  describe('CPU only (no GPU)', () => {
    it('greens a model that fits in usable RAM', () => {
      expect(
        estimateModelFit(8 * GB, DEFAULT_CTX_LENGTH, baseHardware({ total_memory: 32 * 1024 }))
      ).toBe('green')
    })

    it('reds a model larger than usable RAM', () => {
      expect(
        estimateModelFit(20 * GB, DEFAULT_CTX_LENGTH, baseHardware({ total_memory: 16 * 1024 }))
      ).toBe('red')
    })
  })

  it('respects context length when computing required memory', () => {
    const hw = appleSilicon(16)
    expect(estimateModelFit(9 * GB, 2048, hw)).toBe('green')
    expect(estimateModelFit(9 * GB, 32768, hw)).not.toBe('green')
  })
})

const integratedGpu = (ramGib: number, sharedGib: number): HardwareData =>
  baseHardware({
    os_type: 'windows',
    total_memory: ramGib * 1024,
    gpus: [
      {
        name: 'Intel Iris Xe',
        total_memory: sharedGib * 1024,
        vendor: 'intel',
        uuid: 'igpu',
        driver_version: '',
        nvidia_info: { index: 0, compute_capability: '' },
        vulkan_info: {
          index: 0,
          device_id: 0,
          device_type: 'IntegratedGpu',
          api_version: '',
        },
      },
    ],
  })

// Llama 3 8B's attention shape: 32 layers, 8 KV heads, 128-dim heads.
const llama3Arch = {
  layers: 32,
  kvHeads: 8,
  keyLength: 128,
  valueLength: 128,
  trainedContext: 8192,
}

describe('assessModelFit (deterministic hardware accounting)', () => {
  it('does not subtract the system reserve from dedicated VRAM', () => {
    // 5.5 GiB at 4k needs ~6.5 GiB. The old heuristic left 5.9 GiB of an 8 GiB
    // card and called it a spill; a 512 MiB driver reserve leaves 7.5 GiB.
    const result = assessModelFit({
      weightsBytes: 5.5 * GB,
      ctxLength: 4096,
      hardware: withDiscreteGpu(32, 8),
    })
    expect(result.memoryModel).toBe('discrete-gpu')
    expect(result.budgets.gpu).toBe(8 * GB - DISCRETE_VRAM_RESERVE_BYTES)
    expect(result.verdict).toBe('fits')
  })

  it('treats a model that spills into RAM as runnable with partial offload', () => {
    const result = assessModelFit({
      weightsBytes: 12 * GB,
      ctxLength: 4096,
      hardware: withDiscreteGpu(32, 8),
    })
    expect(result.verdict).toBe('fits-partial-offload')
    expect(estimateModelFit(12 * GB, 4096, withDiscreteGpu(32, 8))).toBe('yellow')
  })

  it('does not double count integrated GPU memory, which is system RAM', () => {
    const hw = integratedGpu(16, 8)
    const result = assessModelFit({ weightsBytes: 13 * GB, ctxLength: 4096, hardware: hw })
    expect(result.memoryModel).toBe('integrated-gpu')
    expect(result.budgets.dedicatedVram).toBe(0)
    expect(result.budgets.total).toBe(16 * GB - SYSTEM_RESERVE_BYTES)
    expect(result.budgets.gpu).toBe(result.budgets.total)
    expect(result.verdict).toBe('exceeds')
    expect(result.assumptions).toContain('integrated-gpu-shares-ram')
  })

  it('keeps unified memory as one pool with the GPU budget inside it', () => {
    const result = assessModelFit({
      weightsBytes: 4 * GB,
      ctxLength: 4096,
      hardware: appleSilicon(16),
    })
    expect(result.memoryModel).toBe('unified')
    expect(result.budgets.total).toBe(16 * GB - UNIFIED_SYSTEM_RESERVE_BYTES)
    expect(result.budgets.gpu).toBeLessThanOrEqual(result.budgets.total)
    expect(result.budgets.dedicatedVram).toBe(0)
  })

  it('uses the larger Metal share on large unified-memory machines', () => {
    const small = assessModelFit({ weightsBytes: GB, ctxLength: 4096, hardware: appleSilicon(16) })
    const large = assessModelFit({ weightsBytes: GB, ctxLength: 4096, hardware: appleSilicon(64) })
    expect(small.budgets.gpu).toBeCloseTo(16 * GB * 0.67)
    expect(large.budgets.gpu).toBeCloseTo(64 * GB * 0.75)
  })

  it('sizes the KV cache from GGUF metadata when it is available', () => {
    const result = assessModelFit({
      weightsBytes: 4.7 * GB,
      ctxLength: 8192,
      hardware: withDiscreteGpu(32, 12),
      architecture: llama3Arch,
    })
    // 32 layers * 8 heads * (128 + 128) * 2 bytes * 8192 tokens = 1 GiB.
    expect(result.required.kvCache).toBe(GB)
    expect(result.kvMethod).toBe('gguf-metadata')
    expect(result.uncertainty).toBe('low')
  })

  it('shrinks the KV cache for quantized cache types', () => {
    const f16 = kvCacheBytesFromArchitecture(llama3Arch, 8192)
    const q8 = kvCacheBytesFromArchitecture(llama3Arch, 8192, 'q8_0', 'q8_0')
    expect(q8.bytes).toBeCloseTo(f16.bytes * (34 / 32 / 2))
  })

  it('caps the context at what the model was trained on', () => {
    const result = assessModelFit({
      weightsBytes: 4.7 * GB,
      ctxLength: 131072,
      hardware: withDiscreteGpu(32, 12),
      architecture: llama3Arch,
    })
    expect(result.effectiveContext).toBe(8192)
    expect(result.assumptions).toContain('context-capped-to-trained')
  })

  it('flags the sliding-window estimate as uncertain', () => {
    const result = assessModelFit({
      weightsBytes: 4 * GB,
      ctxLength: 32768,
      hardware: withDiscreteGpu(64, 24),
      architecture: { ...llama3Arch, trainedContext: 131072, slidingWindow: 4096 },
    })
    expect(result.assumptions).toContain('kv-sliding-window-midpoint')
    expect(result.uncertainty).not.toBe('low')
  })

  it('marks the heuristic KV estimate as medium uncertainty', () => {
    const result = assessModelFit({
      weightsBytes: 4 * GB,
      ctxLength: 4096,
      hardware: withDiscreteGpu(32, 16),
    })
    expect(result.kvMethod).toBe('file-size-heuristic')
    expect(result.uncertainty).toBe('medium')
  })

  it('removes the GPU budget when GPU layers are set to 0', () => {
    const result = assessModelFit({
      weightsBytes: 4 * GB,
      ctxLength: 4096,
      hardware: withDiscreteGpu(32, 16),
      gpuLayers: 0,
    })
    expect(result.budgets.gpu).toBe(0)
    expect(result.budgets.total).toBe(32 * GB - SYSTEM_RESERVE_BYTES)
    expect(result.verdict).toBe('fits')
    expect(result.assumptions).toContain('cpu-only-by-setting')
  })

  it('subtracts models that stay loaded alongside', () => {
    const alone = assessModelFit({ weightsBytes: 8 * GB, ctxLength: 4096, hardware: baseHardware() })
    const shared = assessModelFit({
      weightsBytes: 8 * GB,
      ctxLength: 4096,
      hardware: baseHardware(),
      otherLoadedBytes: 6 * GB,
    })
    expect(alone.verdict).toBe('fits')
    expect(shared.budgets.total).toBe(alone.budgets.total - 6 * GB)
    expect(shared.verdict).toBe('exceeds')
  })

  it('calls a fit with under 10% headroom tight rather than comfortable', () => {
    // CPU only, 16 GiB: budget 14 GiB. 11.5 GiB + 1.15 KV + 0.52 overhead ≈ 13.2.
    const result = assessModelFit({ weightsBytes: 11.5 * GB, ctxLength: 4096, hardware: baseHardware() })
    expect(result.verdict).toBe('tight')
    expect(result.uncertainty).toBe('high')
  })

  it('reports unknown without a size or hardware probe', () => {
    expect(assessModelFit({ weightsBytes: null, ctxLength: 4096, hardware: baseHardware() }).verdict).toBe('unknown')
    expect(
      assessModelFit({ weightsBytes: GB, ctxLength: 4096, hardware: baseHardware({ total_memory: 0 }) }).verdict
    ).toBe('unknown')
  })

  it('includes the vision projector when its size is known', () => {
    const result = assessModelFit({
      weightsBytes: 4 * GB,
      ctxLength: 4096,
      hardware: baseHardware({ total_memory: 32 * 1024 }),
      mmprojBytes: 600 * 1024 * 1024,
    })
    expect(result.required.mmproj).toBe(600 * 1024 * 1024)
  })
})

describe('kvArchitectureFromGguf', () => {
  it('reads the attention shape from GGUF keys', () => {
    expect(
      kvArchitectureFromGguf({
        'general.architecture': 'llama',
        'llama.block_count': '32',
        'llama.attention.head_count': '32',
        'llama.attention.head_count_kv': '8',
        'llama.attention.key_length': '128',
        'llama.attention.value_length': '128',
        'llama.context_length': '8192',
      })
    ).toEqual(llama3Arch)
  })

  it('derives head size from the embedding length when key length is missing', () => {
    const arch = kvArchitectureFromGguf({
      'general.architecture': 'qwen2',
      'qwen2.block_count': '28',
      'qwen2.attention.head_count': '28',
      'qwen2.attention.head_count_kv': '4',
      'qwen2.embedding_length': '3584',
    })
    expect(arch).toMatchObject({ layers: 28, kvHeads: 4, keyLength: 128, valueLength: 128 })
  })

  it('returns null when the metadata cannot size a cache', () => {
    expect(kvArchitectureFromGguf(undefined)).toBeNull()
    expect(kvArchitectureFromGguf({ 'general.architecture': 'llama' })).toBeNull()
  })
})

describe('estimateKvCacheBytes for large files', () => {
  it('keeps 10% per 4k up to the knee', () => {
    expect(estimateKvCacheBytes(12 * GB, 4096)).toBeCloseTo(1.2 * GB)
  })

  it('shrinks the share for very large models but stays above the real cache', () => {
    // A 70B Q4 (~42.5 GB, 80 layers, 8 KV heads, 128 head dim) keeps ~2.7 GB
    // of cache at 8k; the old flat 10% estimated 8.5 GB.
    const estimate = estimateKvCacheBytes(42.5 * GB, 8192)
    expect(estimate).toBeLessThan(6 * GB)
    expect(estimate).toBeGreaterThan(2.7 * GB)
  })
})

describe('assessModelFit across real machines', () => {
  const igpu = baseHardware({
    gpus: [
      {
        ...withDiscreteGpu(16, 1).gpus[0],
        vulkan_info: {
          index: 0,
          device_id: 0,
          device_type: 'IntegratedGpu',
          api_version: '',
        },
      },
    ],
  })
  const verdict = (hardware: HardwareData, gb: number, mmprojGb = 0) =>
    assessModelFit({
      weightsBytes: gb * GB,
      mmprojBytes: mmprojGb * GB,
      ctxLength: DEFAULT_CTX_LENGTH,
      hardware,
    }).verdict

  it.each([
    ['8 GB CPU-only', baseHardware({ total_memory: 8 * 1024 }), 1.9, 'fits'],
    ['8 GB CPU-only', baseHardware({ total_memory: 8 * 1024 }), 4.9, 'exceeds'],
    ['16 GB CPU-only', baseHardware(), 4.9, 'fits'],
    ['16 GB CPU-only', baseHardware(), 19, 'exceeds'],
    ['8 GB GPU / 16 GB RAM', withDiscreteGpu(16, 8), 4.9, 'fits'],
    ['8 GB GPU / 16 GB RAM', withDiscreteGpu(16, 8), 8.5, 'fits-partial-offload'],
    ['8 GB GPU / 16 GB RAM', withDiscreteGpu(16, 8), 42.5, 'exceeds'],
    ['8 GB GPU / 64 GB RAM', withDiscreteGpu(64, 8), 42.5, 'fits-partial-offload'],
    ['24 GB GPU / 32 GB RAM', withDiscreteGpu(32, 24), 19, 'fits'],
    ['integrated GPU, 16 GB', igpu, 8.5, 'fits'],
    ['integrated GPU, 16 GB', igpu, 19, 'exceeds'],
    ['Apple silicon 8 GB', appleSilicon(8), 4.9, 'exceeds'],
    ['Apple silicon 16 GB', appleSilicon(16), 4.9, 'fits'],
    ['Apple silicon 64 GB', appleSilicon(64), 42.5, 'fits-partial-offload'],
  ] as const)('%s, %s GB model: %s', (_name, hardware, gb, expected) => {
    expect(verdict(hardware, gb)).toBe(expected)
  })

  it('counts a downloaded vision projector against memory', () => {
    const hardware = withDiscreteGpu(16, 8)
    expect(verdict(hardware, 5.6)).toBe('fits')
    expect(verdict(hardware, 5.6, 1.5)).toBe('fits-partial-offload')
  })

  it('does not guess when the machine has not been measured', () => {
    expect(verdict(baseHardware({ total_memory: 0 }), 4.9)).toBe('unknown')
  })

  it('does not guess when the file size is unknown', () => {
    expect(
      assessModelFit({
        weightsBytes: null,
        ctxLength: DEFAULT_CTX_LENGTH,
        hardware: baseHardware(),
      }).verdict
    ).toBe('unknown')
  })
})
