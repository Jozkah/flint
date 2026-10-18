import { describe, expect, it } from 'vitest'
import { groupModelsByFamily, modelFamily } from '@/lib/modelGroups'

const fake = (name: string) => ({ id: `models/${name}`, name })

describe('modelFamily', () => {
  it('uses the leading letters of the name, ignoring the repo prefix', () => {
    expect(modelFamily({ id: 'bartowski/Qwen3-8B-Q4_K_M' })).toBe('qwen')
    expect(modelFamily({ id: 'x', name: 'llama-3.1-8b' })).toBe('llama')
    expect(modelFamily({ id: '123-model' })).toBe('model')
    expect(modelFamily({ id: '2024' })).toBe('other')
  })
})

describe('groupModelsByFamily', () => {
  it('groups 25 fake models, folding single-model families into other', () => {
    const models = [
      ...Array.from({ length: 10 }, (_, i) => fake(`qwen3-${i}b`)),
      ...Array.from({ length: 8 }, (_, i) => fake(`llama-${i}`)),
      ...Array.from({ length: 5 }, (_, i) => fake(`gemma-${i}`)),
      fake('phi-4'),
      fake('mistral-7b'),
    ]
    const groups = groupModelsByFamily(models)
    expect(groups.map((g) => g.family)).toEqual([
      'gemma',
      'llama',
      'qwen',
      'other',
    ])
    expect(groups.map((g) => g.models.length)).toEqual([5, 8, 10, 2])
    expect(groups.flatMap((g) => g.models)).toHaveLength(25)
  })

  it('keeps model order inside a group', () => {
    const groups = groupModelsByFamily([fake('a-2'), fake('a-1'), fake('b-1')])
    expect(groups[0].models.map((m) => m.name)).toEqual(['a-2', 'a-1'])
  })
})
