import { describe, expect, it } from 'vitest'
import {
  chooseDraft,
  chooseMmproj,
  cleanHuggingFaceRepo,
  groupHuggingFaceFiles,
  mlxWeightsBytes,
  quantizationFromFilename,
  repoFromDeepLink,
  splitInfo,
  type HuggingFaceFile,
} from '@/lib/huggingface'

const file = (name: string, size = 100): HuggingFaceFile => ({ name, size })

describe('Hugging Face repository input', () => {
  it('accepts an owner/repo id', () => {
    expect(cleanHuggingFaceRepo('bartowski/Qwen3-GGUF')).toBe('bartowski/Qwen3-GGUF')
  })

  it('normalizes a pasted Hugging Face URL', () => {
    expect(
      cleanHuggingFaceRepo('https://huggingface.co/bartowski/Qwen3-GGUF?foo=bar')
    ).toBe('bartowski/Qwen3-GGUF')
  })
})

describe('GGUF variant grouping', () => {
  it('keeps multipart GGUF shards as one variant', () => {
    const groups = groupHuggingFaceFiles([
      file('Qwen3-Q4_K_M-00002-of-00002.gguf', 200),
      file('Qwen3-Q4_K_M-00001-of-00002.gguf', 150),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].multipart).toBe(true)
    expect(groups[0].files.map((entry) => entry.name)).toEqual([
      'Qwen3-Q4_K_M-00001-of-00002.gguf',
      'Qwen3-Q4_K_M-00002-of-00002.gguf',
    ])
    expect(groups[0].totalSize).toBe(350)
    expect(groups[0].quantization).toBe('Q4_K_M')
  })

  it('separates model, mmproj and speculative draft companions', () => {
    const groups = groupHuggingFaceFiles([
      file('model-Q4_K_M.gguf'),
      file('mmproj-F16.gguf'),
      file('model-Q4_K_M-mtp.gguf'),
    ])
    expect(groups.map((group) => group.kind).sort()).toEqual([
      'draft',
      'mmproj',
      'model',
    ])
    expect(chooseMmproj(groups)?.primary.name).toBe('mmproj-F16.gguf')
    expect(chooseDraft(groups, groups.find((group) => group.kind === 'model')!)?.primary.name)
      .toBe('model-Q4_K_M-mtp.gguf')
  })
})

describe('deep links', () => {
  it('opens a plain owner/name repository', () => {
    expect(repoFromDeepLink('flint://models/huggingface/unsloth/Qwen3-GGUF')).toBe(
      'unsloth/Qwen3-GGUF'
    )
    expect(repoFromDeepLink('jan://models/owner/repo')).toBe('owner/repo')
  })

  it('ignores anything else', () => {
    expect(repoFromDeepLink('flint://settings/huggingface/a/b')).toBeNull()
    expect(repoFromDeepLink('flint://models/huggingface/a/b/c')).toBeNull()
    expect(repoFromDeepLink('flint://models/huggingface/..%2Fetc/x')).toBeNull()
    expect(repoFromDeepLink('not a url')).toBeNull()
  })
})

describe('quantization parsing', () => {
  it('recognizes common K quants', () => {
    expect(quantizationFromFilename('foo-Q5_K_M.gguf')).toBe('Q5_K_M')
    expect(quantizationFromFilename('foo-q4_k_m.gguf')).toBe('Q4_K_M')
  })

  it('recognizes split file names', () => {
    expect(splitInfo('foo-Q4_K_M-00001-of-00003.gguf')).toEqual({
      index: 1,
      total: 3,
      base: 'foo-Q4_K_M',
    })
  })
})

describe('MLX weight size', () => {
  it('sums the safetensors shards only', () => {
    expect(
      mlxWeightsBytes([
        { name: 'model-00001-of-00002.safetensors', size: 100 },
        { name: 'model-00002-of-00002.safetensors', size: 50 },
        { name: 'config.json', size: 3 },
      ])
    ).toBe(150)
  })

  it('is unknown when any shard has no size or there are none', () => {
    expect(mlxWeightsBytes([{ name: 'a.safetensors' }])).toBeNull()
    expect(mlxWeightsBytes([{ name: 'config.json', size: 3 }])).toBeNull()
  })
})
