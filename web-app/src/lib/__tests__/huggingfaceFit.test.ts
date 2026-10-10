import { describe, expect, it } from 'vitest'
import type { HardwareData } from '@/hooks/useHardware'
import {
  approxWeightsBytes,
  groupHuggingFaceFiles,
  type HuggingFaceFile,
} from '../huggingface'
import {
  bestGroup,
  fitBasis,
  fitOfGroup,
  repoFit,
  repoFitsHardware,
} from '../huggingfaceFit'
import { assessModelFit, withoutDisabledGpus } from '../modelCompatibility'

const GB = 1024 ** 3

const hardware = (): HardwareData => ({
  cpu: { arch: 'x86_64', core_count: 8, extensions: [], name: 'CPU', usage: 0 },
  gpus: [
    {
      name: 'NVIDIA GeForce RTX 4060',
      total_memory: 8 * 1024,
      vendor: 'nvidia',
      uuid: '0',
      driver_version: '',
      nvidia_info: { index: 0, compute_capability: '8.9' },
      vulkan_info: {
        index: 0,
        device_id: 0,
        device_type: 'DiscreteGpu',
        api_version: '',
      },
    },
  ],
  os_type: 'windows',
  os_name: 'win',
  total_memory: 16 * 1024,
})

const files = (
  ...items: Array<[string, number | undefined]>
): HuggingFaceFile[] =>
  items.map(([name, size]) => ({
    name,
    size: size == null ? undefined : size * GB,
  }))

describe('GPUs switched off in Settings', () => {
  const devices = (activated: boolean) => [
    { name: 'NVIDIA GeForce RTX 4060', activated },
    { name: 'NVIDIA GeForce RTX 4060', activated },
  ]

  it('leaves a GPU out when every one of its devices is off', () => {
    expect(withoutDisabledGpus(hardware(), devices(false)).gpus).toHaveLength(0)
  })

  it('keeps it when any device is on, or when llama.cpp does not list it', () => {
    expect(withoutDisabledGpus(hardware(), devices(true)).gpus).toHaveLength(1)
    expect(
      withoutDisabledGpus(hardware(), [
        { name: 'Some Other GPU', activated: false },
      ]).gpus
    ).toHaveLength(1)
    expect(withoutDisabledGpus(hardware(), undefined).gpus).toHaveLength(1)
  })

  it('changes the verdict for an 8.5 GB model', () => {
    const on = assessModelFit({
      weightsBytes: 8.5 * GB,
      ctxLength: 8192,
      hardware: hardware(),
      devices: devices(true),
    })
    const off = assessModelFit({
      weightsBytes: 8.5 * GB,
      ctxLength: 8192,
      hardware: hardware(),
      devices: devices(false),
    })
    expect(on.verdict).toBe('fits-partial-offload')
    expect(off.verdict).toBe('fits')
    expect(off.memoryModel).toBe('cpu-only')
    expect(off.assumptions).toContain('gpu-disabled-in-settings')
  })
})

describe('fitOfGroup', () => {
  it('sizes a file the listing gave no length for from its parameters', () => {
    const bytes = approxWeightsBytes(8, 'Q4_K_M')!
    expect(bytes / GB).toBeGreaterThan(4.3)
    expect(bytes / GB).toBeLessThan(5.2)
    const groups = groupHuggingFaceFiles(files(['m-Q4_K_M.gguf', undefined]))
    const fit = fitOfGroup(groups[0], groups, {
      hardware: hardware(),
      parameterBillions: 8,
    })
    expect(fit.verdict).toBe('fits')
    expect(fit.sizeEstimated).toBe(true)
    expect(fitBasis(fit)).toContain('estimated from parameters')
  })

  it('has no verdict without a size and without parameters', () => {
    const groups = groupHuggingFaceFiles(files(['m-Q4_K_M.gguf', undefined]))
    const fit = fitOfGroup(groups[0], groups, { hardware: hardware() })
    expect(fit.verdict).toBe('unknown')
    expect(fit.sizeEstimated).toBe(false)
  })

  it('says whether the context memory was read from the file', () => {
    const groups = groupHuggingFaceFiles(files(['m-Q4_K_M.gguf', 4.9]))
    const estimated = fitOfGroup(groups[0], groups, { hardware: hardware() })
    const exact = fitOfGroup(groups[0], groups, {
      hardware: hardware(),
      architecture: { layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 },
    })
    expect(fitBasis(estimated)).toContain('estimated from the file size')
    expect(fitBasis(exact)).toContain('read from the model file')
    expect(exact.required.kvCache).toBe(1024 ** 3)
  })

  it('recommends the best quantization that still fits', () => {
    const groups = groupHuggingFaceFiles(
      files(['m-Q4_K_M.gguf', 4.9], ['m-Q5_K_M.gguf', 5.7], ['m-Q8_0.gguf', 8.5])
    )
    expect(bestGroup(groups, { hardware: hardware() })?.quantization).toBe(
      'Q5_K_M'
    )
  })
})

describe('Hub "fits my hardware" filter', () => {
  const repo = { id: 'a/b', author: 'a', downloads: 0, likes: 0, gated: false, tags: ['gguf'], files: [] }
  const ctx = { hardware: hardware() }

  it('drops a repo whose best variant exceeds memory', () => {
    const fit = repoFit(repo, files(['m-Q4_K_M.gguf', 400]), ctx)
    expect(fit?.verdict).toBe('exceeds')
    expect(repoFitsHardware(fit)).toBe(false)
  })

  it('keeps a repo with a variant that fits', () => {
    const fit = repoFit(repo, files(['m-Q4_K_M.gguf', 2]), ctx)
    expect(repoFitsHardware(fit)).toBe(true)
  })

  it('picks the smaller variant when one fits and another does not', () => {
    const fit = repoFit(
      repo,
      files(['m-Q8_0.gguf', 400], ['m-Q2_K.gguf', 2]),
      ctx
    )
    expect(repoFitsHardware(fit)).toBe(true)
  })

  it('keeps a repo it cannot judge', () => {
    expect(repoFit(repo, [], ctx)).toBeNull()
    expect(repoFitsHardware(null)).toBe(true)
  })
})
