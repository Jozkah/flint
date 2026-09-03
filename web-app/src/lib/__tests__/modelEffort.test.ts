import { describe, expect, it } from 'vitest'
import {
  EFFORT_LEVELS,
  EFFORT_SETTING_KEY,
  effortLabel,
  effortOf,
  isEffortLevel,
  supportedEffortLevels,
  supportsEffort,
} from '@/lib/modelEffort'
import { buildReasoningProviderOptions } from '@/lib/reasoningProviderOptions'

const model = (id: string, effort?: string): Model =>
  ({
    id,
    settings: effort
      ? {
          [EFFORT_SETTING_KEY]: {
            key: EFFORT_SETTING_KEY,
            title: 'Reasoning Effort',
            description: '',
            controller_type: 'dropdown',
            controller_props: { value: effort },
          },
        }
      : {},
  }) as unknown as Model

describe('which levels a provider actually honours', () => {
  it('offers all four for OpenAI, which maps each to a distinct effort', () => {
    expect(supportedEffortLevels('openai', model('gpt-5'))).toEqual(
      EFFORT_LEVELS
    )
  })

  it('offers all four for llama.cpp, which sizes a budget from each', () => {
    expect(supportedEffortLevels('llamacpp', model('qwen3'))).toEqual(
      EFFORT_LEVELS
    )
  })

  it('offers all four for an Anthropic model that takes an explicit budget', () => {
    // Pre-4.6 models require enabled + budget_tokens, so a level is meaningful.
    // The ids are the shapes `buildReasoningProviderOptions` recognises —
    // `<family>-<version>` — since this mirrors that test exactly rather than
    // inventing a second opinion about which models are pre-4.6.
    for (const id of ['claude-opus-3', 'claude-sonnet-4-5', 'claude-haiku-3']) {
      expect(supportedEffortLevels('anthropic', model(id)), id).toEqual(
        EFFORT_LEVELS
      )
    }
  })

  it('offers none for an Anthropic model that reasons adaptively', () => {
    // 4.6+ sizes its own thinking; a level changes nothing, so a control here
    // would be four stops that all do the same thing.
    for (const id of ['claude-opus-4-6', 'claude-sonnet-4-7']) {
      expect(supportedEffortLevels('anthropic', model(id)), id).toEqual([])
      expect(supportsEffort('anthropic', model(id)), id).toBe(false)
    }
  })

  it('offers none for Google, whose budget is dynamic rather than stepped', () => {
    expect(supportedEffortLevels('google', model('gemini-3-pro'))).toEqual([])
    expect(supportedEffortLevels('gemini', model('gemini-3-pro'))).toEqual([])
  })

  it('offers none for a provider with no reasoning mapping at all', () => {
    expect(supportedEffortLevels('mistral', model('mistral-large'))).toEqual([])
    expect(supportedEffortLevels(null, model('x'))).toEqual([])
    expect(supportedEffortLevels(undefined, undefined)).toEqual([])
  })

  /**
   * The control and the request must agree. A level is worth offering only if
   * choosing it changes what the provider receives — so for every provider
   * that offers levels, two different levels must produce two different
   * requests, and for every provider that offers none, they must not.
   */
  it('offers levels exactly where they change the request', () => {
    const cases: Array<[string, string]> = [
      ['openai', 'gpt-5'],
      ['anthropic', 'claude-opus-3'],
      ['anthropic', 'claude-opus-4-6'],
      ['google', 'gemini-3-pro'],
    ]
    for (const [provider, id] of cases) {
      const low = JSON.stringify(
        buildReasoningProviderOptions(provider, model(id, 'low')) ?? null
      )
      const high = JSON.stringify(
        buildReasoningProviderOptions(provider, model(id, 'xhigh')) ?? null
      )
      const changes = low !== high
      expect(
        supportsEffort(provider, model(id)),
        `${provider}/${id}: request changes=${changes}`
      ).toBe(changes)
    }
  })
})

describe('reading the level in force', () => {
  it('reports the level a model is set to', () => {
    expect(effortOf(model('gpt-5', 'high'))).toBe('high')
  })

  it('reports none when the model is at its own default', () => {
    expect(effortOf(model('gpt-5'))).toBeNull()
    expect(effortOf(null)).toBeNull()
  })

  it('treats "unlimited" as no effort, because it is the absence of one', () => {
    expect(effortOf(model('gpt-5', 'unlimited'))).toBeNull()
    expect(isEffortLevel('unlimited')).toBe(false)
  })

  it('ignores a value that is not a level at all', () => {
    expect(effortOf(model('gpt-5', 'banana'))).toBeNull()
    expect(isEffortLevel(42)).toBe(false)
    expect(isEffortLevel(undefined)).toBe(false)
  })
})

describe('labels', () => {
  it('uses the labels the shared level list already defines', () => {
    expect(EFFORT_LEVELS.map(effortLabel)).toEqual([
      'Low',
      'Medium',
      'High',
      'XHigh',
    ])
  })
})
