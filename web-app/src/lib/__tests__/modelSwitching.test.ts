import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useModelOverrides } from '@/hooks/useModelOverrides'
import { effectiveValue, resolveModel } from '@/lib/modelOverrides'
import {
  EFFORT_SETTING_KEY,
  effortOf,
  supportedEffortLevels,
  supportsEffort,
} from '@/lib/modelEffort'
import { buildReasoningProviderOptions } from '@/lib/reasoningProviderOptions'

/**
 * What happens to a chat's overrides when its model changes underneath it.
 *
 * These span the override layer, the capability filter and the request
 * builder, because the guarantee only holds if all three agree: the control
 * disappears, the value stops reaching the provider, and the record does not
 * quietly keep a setting that would come back later.
 */

const CHAT = 'thread-a'
const store = () => useModelOverrides.getState()

const model = (id: string, settings: Record<string, unknown>): Model =>
  ({
    id,
    settings: Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [
        key,
        {
          key,
          title: key,
          description: '',
          controller_type: 'dropdown',
          controller_props: { value },
        },
      ])
    ),
  }) as unknown as Model

/** An OpenAI reasoning model: four discrete efforts, plus a temperature. */
const openaiModel = () =>
  model('gpt-5', { [EFFORT_SETTING_KEY]: 'medium', temperature: 0.7 })

/** A model with no reasoning setting at all. */
const plainModel = () => model('mistral-large', { temperature: 0.7 })

/** Anthropic 4.6+: reasons adaptively, so a level changes nothing. */
const adaptiveModel = () =>
  model('claude-opus-4-6', { [EFFORT_SETTING_KEY]: 'medium' })

describe('switching a chat to a model that does not support effort', () => {
  beforeEach(() => {
    useModelOverrides.setState({ byThread: {} })
  })

  it('takes the control off screen', () => {
    // The composer renders the slider only while there are levels to show.
    expect(supportsEffort('openai', openaiModel())).toBe(true)

    expect(supportedEffortLevels('mistral', plainModel())).toEqual([])
    expect(supportsEffort('mistral', plainModel())).toBe(false)
    // …and for a provider that reasons but ignores the level.
    expect(supportsEffort('anthropic', adaptiveModel())).toBe(false)
    expect(supportsEffort('google', model('gemini-3-pro', {}))).toBe(false)
  })

  it('sends no effort to a provider that would not honour one', () => {
    // Even with the override still in the record, the request carries nothing
    // the new provider does not act on.
    store().setForThread(CHAT, EFFORT_SETTING_KEY, 'xhigh')

    const resolved = resolveModel(adaptiveModel(), store().forThread(CHAT))
    const options = buildReasoningProviderOptions('anthropic', resolved)

    // Adaptive thinking, sized by the model — no budget derived from a level.
    expect(JSON.stringify(options ?? {})).not.toContain('budgetTokens')

    // And a provider with no reasoning mapping at all sends nothing.
    expect(
      buildReasoningProviderOptions(
        'mistral',
        resolveModel(plainModel(), store().forThread(CHAT))
      )
    ).toBeUndefined()
  })

  it('sends nothing at all once the override has been pruned', () => {
    store().setForThread(CHAT, EFFORT_SETTING_KEY, 'xhigh')
    store().pruneForThread(CHAT, 'mistral', plainModel())

    const resolved = resolveModel(plainModel(), store().forThread(CHAT))
    expect(effortOf(resolved)).toBeNull()
    expect(buildReasoningProviderOptions('openai', resolved)).toBeUndefined()
  })

  it('does not revive the override when the old model comes back', () => {
    // The chat had xhigh on OpenAI. Switch to a provider that cannot act on an
    // effort level — the override is dropped — then switch back: the chat must
    // inherit the global default, not the value it used to have.
    store().setForThread(CHAT, EFFORT_SETTING_KEY, 'xhigh')
    store().pruneForThread(CHAT, 'mistral', plainModel())
    expect(store().forThread(CHAT)[EFFORT_SETTING_KEY]).toBeUndefined()

    store().pruneForThread(CHAT, 'openai', openaiModel())
    const back = resolveModel(openaiModel(), store().forThread(CHAT))

    expect(store().forThread(CHAT)[EFFORT_SETTING_KEY]).toBeUndefined()
    // The global default for that model, which is 'medium'.
    expect(effortOf(back)).toBe('medium')
    expect(
      effectiveValue(openaiModel(), store().forThread(CHAT), EFFORT_SETTING_KEY)
    ).toBe('medium')
  })

  it('keeps the overrides the new model still defines', () => {
    // Only what the new model cannot express is dropped; the rest is the
    // user's choice and stays theirs.
    store().setForThread(CHAT, EFFORT_SETTING_KEY, 'xhigh')
    store().setForThread(CHAT, 'temperature', 0.1)

    store().pruneForThread(CHAT, 'mistral', plainModel())

    expect(store().forThread(CHAT)).toEqual({ temperature: 0.1 })
    const resolved = resolveModel(plainModel(), store().forThread(CHAT))
    expect(resolved.settings?.temperature?.controller_props?.value).toBe(0.1)
  })

  it('leaves a chat that overrode nothing with nothing to prune', () => {
    store().pruneForThread(CHAT, 'mistral', plainModel())
    expect(CHAT in store().byThread).toBe(false)
  })

  it('does not touch another chat when one switches model', () => {
    store().setForThread(CHAT, EFFORT_SETTING_KEY, 'xhigh')
    store().setForThread('thread-b', EFFORT_SETTING_KEY, 'low')

    store().pruneForThread(CHAT, 'mistral', plainModel())

    expect(store().forThread('thread-b')[EFFORT_SETTING_KEY]).toBe('low')
  })
})
