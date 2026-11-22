import { describe, expect, it } from 'vitest'
import {
  modelContextWindow,
  modelMaxOutputTokens,
  modelOverride,
  withModelLimits,
} from '../modelLimits'

describe('modelLimits', () => {
  it('reads the model window, then its old Max Context Tokens setting', () => {
    expect(modelContextWindow({ contextWindow: 128000 })).toBe(128000)
    expect(
      modelContextWindow({
        settings: { max_context_tokens: { controller_props: { value: '32768' } } },
      })
    ).toBe(32768)
    expect(modelContextWindow({ contextWindow: 0 })).toBeNull()
    expect(modelContextWindow(null)).toBeNull()
  })

  it('reads the reply cap only from the model', () => {
    expect(modelMaxOutputTokens({ maxOutputTokens: 8192 })).toBe(8192)
    expect(modelMaxOutputTokens({})).toBeNull()
  })

  it('lays model limits over the assistant values, which cover a model without any', () => {
    const assistant = { max_output_tokens: 2048, max_context_tokens: 16000, temperature: 0.3 }
    expect(withModelLimits(assistant, { maxOutputTokens: 64000, contextWindow: 200000 })).toEqual({
      temperature: 0.3,
      max_output_tokens: 64000,
      max_context_tokens: 200000,
    })
    expect(withModelLimits(assistant, { maxOutputTokens: 4096 })).toEqual({
      ...assistant,
      max_output_tokens: 4096,
    })
    expect(withModelLimits(assistant, {})).toBe(assistant)
  })

  it('offers the stored window as a user override for capabilities', () => {
    expect(modelOverride({ contextWindow: 1000 })).toEqual({ contextWindow: 1000 })
    expect(modelOverride({})).toBeNull()
  })
})
