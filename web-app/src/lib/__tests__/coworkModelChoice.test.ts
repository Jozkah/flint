import { describe, it, expect } from 'vitest'
import { resolveCoworkModel } from '@/lib/coworkModelChoice'

const qwen = { id: 'qwen3.8-27b' }
const gpt = { id: 'gpt-5' }
const providers = [
  { provider: '8556', active: true, models: [qwen] },
  { provider: 'openai', active: true, models: [gpt] },
  { provider: 'off', active: false, models: [{ id: 'gone' }] },
]
const emptyPicker = { selectedProvider: 'llamacpp', selectedModel: null, providers }

describe('the model a Cowork session sends with', () => {
  it('is the saved model, even when the global picker is empty', () => {
    const r = resolveCoworkModel({ provider: '8556', id: 'qwen3.8-27b' }, emptyPicker)
    expect(r.model).toBe(qwen)
    expect(r.save).toBe(false)
    expect(r.unavailable).toBeNull()
  })

  it("falls back to the picker's model when the saved one is gone, and asks to save it", () => {
    const r = resolveCoworkModel(
      { provider: 'removed', id: 'qwen3.8-27b' },
      { selectedProvider: 'openai', selectedModel: gpt, providers }
    )
    expect(r.model).toBe(gpt)
    expect(r.choice).toEqual({ provider: 'openai', id: 'gpt-5' })
    expect(r.save).toBe(true)
    expect(r.unavailable).toEqual({ provider: 'removed', id: 'qwen3.8-27b' })
  })

  it('reports the saved model as unavailable when nothing can stand in', () => {
    const r = resolveCoworkModel({ provider: 'off', id: 'gone' }, emptyPicker)
    expect(r.model).toBeNull()
    expect(r.save).toBe(false)
    expect(r.unavailable).toEqual({ provider: 'off', id: 'gone' })
  })

  it("takes the picker's model for a session with none, and saves it", () => {
    const r = resolveCoworkModel(undefined, {
      selectedProvider: '8556',
      selectedModel: qwen,
      providers,
    })
    expect(r.model).toBe(qwen)
    expect(r.save).toBe(true)
  })
})
