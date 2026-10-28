import { describe, expect, it } from 'vitest'
import { resolveModel } from '@/lib/modelOverrides'
import { buildReasoningProviderOptions } from '@/lib/reasoningProviderOptions'
import { buildLlamacppReasoningParams } from '@/lib/llamacppReasoning'
import {
  canSwitchReasoning,
  isReasoningDefault,
  withReasoningDefault,
} from '@/lib/reasoningDefault'

const model = (id: string, reasoning?: 'auto' | 'on' | 'off'): Model =>
  ({
    id,
    capabilities: ['reasoning'],
    settings: reasoning
      ? {
          reasoning: {
            key: 'reasoning',
            title: 'Reasoning',
            description: '',
            controller_type: 'dropdown',
            controller_props: { value: reasoning },
          },
        }
      : {},
  }) as unknown as Model

const reasoningOf = (m: Model | null | undefined) =>
  m?.settings?.reasoning?.controller_props?.value

describe('withReasoningDefault', () => {
  const claude = model('claude-sonnet-4-5', 'auto')

  it('model default leaves everything as it is', () => {
    const o = withReasoningDefault(undefined, 'anthropic', claude, 'model')
    expect(o).toBeUndefined()
    expect(resolveModel(claude, o)).toBe(claude)
  })

  it('off starts a chat with thinking off', () => {
    const o = withReasoningDefault(undefined, 'anthropic', claude, 'off')
    expect(reasoningOf(resolveModel(claude, o))).toBe('off')
  })

  it('on starts a chat with thinking on', () => {
    const o = withReasoningDefault({}, 'anthropic', claude, 'on')
    expect(reasoningOf(resolveModel(claude, o))).toBe('on')
  })

  it('applies to a model with no reasoning setting yet', () => {
    const bare = model('claude-sonnet-4-5')
    const o = withReasoningDefault(undefined, 'anthropic', bare, 'off')
    expect(reasoningOf(resolveModel(bare, o))).toBe('off')
  })

  it('an unknown or missing mode is treated as model default', () => {
    expect(
      withReasoningDefault(undefined, 'anthropic', claude, undefined)
    ).toBeUndefined()
  })

  it("the model's own On/Off setting wins over the default", () => {
    const own = model('claude-sonnet-4-5', 'on')
    const o = withReasoningDefault(undefined, 'anthropic', own, 'off')
    expect(reasoningOf(resolveModel(own, o))).toBe('on')
  })

  it("the chat's composer toggle wins over both", () => {
    const own = model('claude-sonnet-4-5', 'off')
    const chat = { reasoning: 'on' }
    const o = withReasoningDefault(chat, 'anthropic', own, 'off')
    expect(o).toBe(chat)
    expect(reasoningOf(resolveModel(own, o))).toBe('on')
  })

  it('keeps the chat\'s other overrides', () => {
    const o = withReasoningDefault(
      { temperature: 0.2 },
      'anthropic',
      claude,
      'off'
    )
    expect(o).toEqual({ temperature: 0.2, reasoning: 'off' })
  })

  it('leaves a model that cannot switch thinking untouched', () => {
    // A remote OpenAI-compatible model with no known reasoning knob.
    const plain = model('some-random-model')
    expect(canSwitchReasoning('my-proxy', plain)).toBe(false)
    const o = withReasoningDefault(undefined, 'my-proxy', plain, 'off')
    expect(o).toBeUndefined()
    expect(
      buildReasoningProviderOptions('my-proxy', resolveModel(plain, o))
    ).toBeUndefined()
  })

  it('does not send enable_thinking to a local model that does not reason', () => {
    const local = { id: 'llama-3.2-1b', settings: {} } as unknown as Model
    expect(canSwitchReasoning('llamacpp', local)).toBe(false)
    const o = withReasoningDefault(undefined, 'llamacpp', local, 'off')
    const resolved = resolveModel(local, o)
    expect(
      buildLlamacppReasoningParams(
        'llamacpp',
        reasoningOf(resolved) as 'auto' | 'on' | 'off' | undefined,
        undefined
      )
    ).toEqual({})
  })

  it('needs a provider and a model', () => {
    expect(canSwitchReasoning(undefined, claude)).toBe(false)
    expect(canSwitchReasoning('anthropic', null)).toBe(false)
  })
})

describe('isReasoningDefault', () => {
  it('accepts the three modes only', () => {
    expect(['model', 'on', 'off'].every(isReasoningDefault)).toBe(true)
    expect(isReasoningDefault('auto')).toBe(false)
    expect(isReasoningDefault(undefined)).toBe(false)
  })
})
