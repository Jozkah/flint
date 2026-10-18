import { describe, it, expect } from 'vitest'
import { modelPickerMeta } from '../usePickerModelMeta'

const m = (extra: Partial<Model> = {}): Model => ({ id: 'qwen', ...extra }) as Model

describe('modelPickerMeta', () => {
  it('marks local engines local and everything else cloud', () => {
    expect(modelPickerMeta(m(), 'llamacpp', [], {}).kind).toBe('local')
    expect(modelPickerMeta(m(), 'mlx', [], {}).kind).toBe('local')
    expect(modelPickerMeta(m(), 'openai', [], {}).kind).toBe('cloud')
  })

  it('carries the model capabilities, adding embeddings for an embedding model', () => {
    expect(modelPickerMeta(m({ capabilities: ['vision', 'tools'] }), 'openai', [], {}).capabilities).toEqual([
      'vision',
      'tools',
    ])
    expect(modelPickerMeta(m({ embedding: true }), 'llamacpp', [], {}).capabilities).toContain('embeddings')
  })

  it('knows what is loaded only for local models', () => {
    expect(modelPickerMeta(m(), 'llamacpp', ['qwen'], {}).loaded).toBe(true)
    expect(modelPickerMeta(m(), 'llamacpp', [], {}).loaded).toBe(false)
    expect(modelPickerMeta(m(), 'openai', ['qwen'], {}).loaded).toBeUndefined()
  })

  it('reads the last-used time from the usage history', () => {
    expect(modelPickerMeta(m(), 'openai', [], { 'openai:qwen': 42 }).lastUsedAt).toBe(42)
    expect(modelPickerMeta(m(), 'openai', [], {}).lastUsedAt).toBeUndefined()
  })
})
