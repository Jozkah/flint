import { describe, it, expect } from 'vitest'
import {
  parseModelName,
  middleTruncate,
  modelNameTail,
  truncateDistinct,
} from '../modelDisplayName'

describe('parseModelName', () => {
  it.each([
    ['Qwen3.6-27B-IQ4_XS', 'IQ4_XS'],
    ['Qwen3.6-27B-Q4_K_M', 'Q4_K_M'],
    ['LFM2.5-2.6B-Q3.8-TBrilliance-BF16.gguf', 'BF16'],
    ['model-UD-Q4_K_XL.gguf', 'UD-Q4_K_XL'],
    ['model-IQ3_XXS', 'IQ3_XXS'],
    ['model-Q8_0.gguf', 'Q8_0'],
    ['model-MXFP4', 'MXFP4'],
    ['model-F16', 'F16'],
  ])('%s -> %s', (id, quant) => {
    expect(parseModelName(id).quant).toBe(quant)
  })
  it('strips quant and extension from base', () => {
    expect(parseModelName('Qwen3.6-27B-Q4_K_M.gguf')).toEqual({
      base: 'Qwen3.6-27B',
      quant: 'Q4_K_M',
    })
  })
  it('no quant', () => {
    expect(parseModelName('gpt-5')).toEqual({ base: 'gpt-5' })
  })
})

describe('middleTruncate', () => {
  it('keeps short names', () => {
    expect(middleTruncate('abc', 10)).toBe('abc')
  })
  it('keeps the tail', () => {
    const out = middleTruncate(
      'Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-IQ4_XS.gguf',
      40
    )
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.startsWith('Qwen3.6-27B')).toBe(true)
    expect(out.endsWith('IQ4_XS.gguf')).toBe(true)
    expect(out).toContain('…')
  })
})

describe('truncateDistinct', () => {
  it('keeps screenshot names apart', () => {
    const names = [
      'Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-IQ4_XS.gguf',
      'Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-Q4_K_M.gguf',
      'LFM2.5-2.6B-Q3.8-TBrilliance-NEO-MAX-Q3_K_M.gguf',
      'LFM2.5-2.6B-Q3.8-TBrilliance-BF16.gguf',
    ]
    const out = truncateDistinct(names, 32)
    expect(new Set(out).size).toBe(names.length)
    expect(out[0].endsWith('IQ4_XS.gguf')).toBe(true)
    expect(out[1].endsWith('Q4_K_M.gguf')).toBe(true)
  })
})

describe('modelNameTail', () => {
  it('keeps the version suffix of a long Bedrock id', () => {
    const name = 'anthropic.claude-sonnet-5-5'
    const tail = modelNameTail(name)
    expect(name.slice(name.length - tail)).toContain('-5-5')
    expect(tail).toBeLessThanOrEqual(name.length / 2)
  })
  it('keeps a quant suffix', () => {
    const name = 'Qwen3-30B-A3B-Instruct-Q4_K_M'
    expect(name.slice(name.length - modelNameTail(name))).toContain('Q4_K_M')
  })
})
