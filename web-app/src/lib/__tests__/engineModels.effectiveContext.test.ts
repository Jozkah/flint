import { describe, it, expect } from 'vitest'
import { effectiveContextLength } from '../engineModels'

const model = (ctx: unknown) =>
  ({
    id: 'm',
    settings: { ctx_len: { key: 'ctx_len', controller_props: { value: ctx } } },
  }) as unknown as Model

const llamacpp = (ctxSize: unknown, fit = false) =>
  ({
    provider: 'llamacpp',
    settings: [
      { key: 'ctx_size', controller_props: { value: ctxSize } },
      { key: 'fit', controller_props: { value: fit } },
    ],
  }) as unknown as ModelProvider

// C046: a model with no context of its own runs at the provider's Default
// context size, and the tables must say so instead of "auto" or a dash.
describe('effectiveContextLength', () => {
  it('prefers the model’s own context', () => {
    expect(effectiveContextLength(model(32768), llamacpp(16384))).toBe(32768)
  })
  it('falls back to the provider’s Default context size', () => {
    expect(effectiveContextLength(model(''), llamacpp(16384))).toBe(16384)
    expect(effectiveContextLength(model(''), llamacpp('100'))).toBe(512)
  })
  it('uses the engine’s 8192 cap when neither is set and auto-fit is off', () => {
    expect(effectiveContextLength(model(''), llamacpp(''))).toBe(8192)
  })
  it('is unknown when auto-fit picks the window', () => {
    expect(effectiveContextLength(model(''), llamacpp('', true))).toBeUndefined()
  })
  it('is unknown for a remote model without its own', () => {
    expect(
      effectiveContextLength(model(''), {
        provider: 'openai',
        settings: [],
      } as unknown as ModelProvider)
    ).toBeUndefined()
  })
})
