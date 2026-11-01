import { describe, expect, it } from 'vitest'
import {
  buildReasoningBodyParams,
  buildReasoningProviderOptions,
} from '../reasoningProviderOptions'

const modelWith = (settings: Record<string, unknown>, id?: string) =>
  ({ id, settings }) as unknown as Model

/** A remote model that declares (or omits) the `reasoning` capability. */
const remoteModel = (reasoning: boolean, settings: Record<string, unknown> = {}) =>
  ({
    id: 'pxa-27b',
    capabilities: reasoning ? ['completion', 'reasoning'] : ['completion'],
    settings,
  }) as unknown as Model

const reasoning = (value: string) => ({
  reasoning: { controller_props: { value } },
})
const budget = (value: string) => ({
  thinking_budget_tokens: { controller_props: { value } },
})

describe('buildReasoningProviderOptions', () => {
  it('returns undefined for unknown/local providers', () => {
    expect(
      buildReasoningProviderOptions('llamacpp', modelWith(reasoning('on')))
    ).toBeUndefined()
    expect(buildReasoningProviderOptions('mlx', null)).toBeUndefined()
  })

  describe('google', () => {
    it('maps reasoning off to a zero thinking budget', () => {
      expect(
        buildReasoningProviderOptions('google', modelWith(reasoning('off')))
      ).toEqual({ google: { thinkingConfig: { thinkingBudget: 0 } } })
    })

    it('maps reasoning on to a dynamic budget with thought summaries', () => {
      expect(
        buildReasoningProviderOptions('google', modelWith(reasoning('on')))
      ).toEqual({
        google: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
      })
    })

    it('enables dynamic thinking when only a budget level is set', () => {
      expect(
        buildReasoningProviderOptions('google', modelWith(budget('high')))
      ).toEqual({
        google: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
      })
    })

    it('returns undefined when reasoning is auto with no level', () => {
      expect(
        buildReasoningProviderOptions('google', modelWith(reasoning('auto')))
      ).toBeUndefined()
    })

    it('matches the real gemini provider id too', () => {
      expect(
        buildReasoningProviderOptions('gemini', modelWith(reasoning('on')))
      ).toEqual({
        google: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
      })
    })
  })

  describe('anthropic', () => {
    it('maps reasoning off to disabled thinking', () => {
      expect(
        buildReasoningProviderOptions('anthropic', modelWith(reasoning('off')))
      ).toEqual({ anthropic: { thinking: { type: 'disabled' } } })
    })

    it('maps reasoning on to adaptive thinking (no token guess)', () => {
      expect(
        buildReasoningProviderOptions('anthropic', modelWith(reasoning('on')))
      ).toEqual({
        anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
      })
    })

    it('returns undefined at provider default', () => {
      expect(
        buildReasoningProviderOptions('anthropic', modelWith({}))
      ).toBeUndefined()
    })

    it('sends adaptive thinking with summarized display on 4.7+ models', () => {
      expect(
        buildReasoningProviderOptions(
          'anthropic',
          modelWith(reasoning('on'), 'claude-opus-4-8')
        )
      ).toEqual({
        anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
      })
    })

    it('omits display on 4.6 models (display shipped with 4.7)', () => {
      expect(
        buildReasoningProviderOptions(
          'anthropic',
          modelWith(reasoning('on'), 'claude-sonnet-4-6')
        )
      ).toEqual({ anthropic: { thinking: { type: 'adaptive' } } })
    })

    it('uses enabled + budget_tokens on pre-4.6 models (adaptive 400s there)', () => {
      expect(
        buildReasoningProviderOptions(
          'anthropic',
          modelWith(reasoning('on'), 'claude-sonnet-4-5')
        )
      ).toEqual({
        anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } },
      })
      expect(
        buildReasoningProviderOptions(
          'anthropic',
          modelWith({ ...budget('high') }, 'claude-haiku-4-5-20251001')
        )
      ).toEqual({
        anthropic: { thinking: { type: 'enabled', budgetTokens: 16384 } },
      })
    })

    it('keeps an enabled budget below the model output ceiling', () => {
      // Opus 4.1 has 32000 output tokens; the xhigh budget (32768) would be
      // refused (budget_tokens must be < max_tokens).
      expect(
        buildReasoningProviderOptions(
          'anthropic',
          modelWith({ ...budget('xhigh') }, 'claude-opus-4-1-20250805')
        )
      ).toEqual({
        anthropic: { thinking: { type: 'enabled', budgetTokens: 25600 } },
      })
      // A dated 4.0 id is pre-4.6 too, and gets the same cap.
      expect(
        buildReasoningProviderOptions(
          'anthropic',
          modelWith({ ...budget('xhigh') }, 'claude-opus-4-20250514')
        )
      ).toEqual({
        anthropic: { thinking: { type: 'enabled', budgetTokens: 25600 } },
      })
    })
  })

  describe('openai', () => {
    it('maps each concrete budget level to a reasoning effort', () => {
      const cases: Array<[string, string]> = [
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['xhigh', 'xhigh'],
      ]
      for (const [level, effort] of cases) {
        expect(
          buildReasoningProviderOptions('openai', modelWith(budget(level)))
        ).toEqual({
          openai: { reasoningEffort: effort, reasoningSummary: 'auto' },
        })
      }
    })

    it('treats unlimited as no explicit effort (model default)', () => {
      expect(
        buildReasoningProviderOptions('openai', modelWith(budget('unlimited')))
      ).toBeUndefined()
    })

    it('returns undefined when no level is chosen (reasoning off has no effort)', () => {
      expect(
        buildReasoningProviderOptions('openai', modelWith(reasoning('off')))
      ).toBeUndefined()
      expect(buildReasoningProviderOptions('openai', modelWith({}))).toBeUndefined()
    })
  })
})

describe('buildReasoningBodyParams', () => {
  it('sends reasoning_effort for a remote reasoning model with a level set', () => {
    expect(
      buildReasoningBodyParams('pxa', remoteModel(true, budget('high')))
    ).toEqual({ reasoning_effort: 'high' })
    // xhigh is a valid stop and must pass through verbatim.
    expect(
      buildReasoningBodyParams('openrouter', remoteModel(true, budget('xhigh')))
    ).toEqual({ reasoning_effort: 'xhigh' })
  })

  it('sends nothing when no level is set, or the level is unlimited', () => {
    expect(buildReasoningBodyParams('pxa', remoteModel(true))).toBeUndefined()
    expect(
      buildReasoningBodyParams('pxa', remoteModel(true, budget('unlimited')))
    ).toBeUndefined()
  })

  it('sends nothing for a remote model that does not declare reasoning', () => {
    expect(
      buildReasoningBodyParams('pxa', remoteModel(false, budget('high')))
    ).toBeUndefined()
  })

  it('sends nothing for the natively-wired providers (they use providerOptions or their own path)', () => {
    for (const provider of [
      'openai',
      'anthropic',
      'google',
      'gemini',
      'llamacpp',
      'mlx',
      'mistral',
      'xai',
    ]) {
      expect(
        buildReasoningBodyParams(provider, remoteModel(true, budget('high'))),
        provider
      ).toBeUndefined()
    }
  })
})

describe('effort per provider', () => {
  const both = (level: string, mode?: string) => ({
    ...budget(level),
    ...(mode ? reasoning(mode) : {}),
  })

  it('sends Anthropic adaptive models the effort option, clamped', () => {
    expect(
      buildReasoningProviderOptions(
        'anthropic',
        modelWith(budget('xhigh'), 'claude-opus-4-7')
      )
    ).toEqual({
      anthropic: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'xhigh',
      },
    })
    // Sonnet 4.6 tops out at high.
    expect(
      buildReasoningProviderOptions(
        'anthropic',
        modelWith(budget('xhigh'), 'claude-sonnet-4-6')
      )
    ).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } })
    // Off still wins over a stored level.
    expect(
      buildReasoningProviderOptions(
        'anthropic',
        modelWith(both('high', 'off'), 'claude-opus-4-7')
      )
    ).toEqual({ anthropic: { thinking: { type: 'disabled' } } })
    // A model with no effort row keeps plain adaptive thinking.
    expect(
      buildReasoningProviderOptions(
        'anthropic',
        modelWith(budget('high'), 'claude-haiku-5-5')
      )
    ).toEqual({
      anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
    })
  })

  it('sends Gemini 3 a thinking level and Gemini 2.5 a budget', () => {
    expect(
      buildReasoningProviderOptions('google', modelWith(budget('low'), 'gemini-3-pro'))
    ).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } },
    })
    // Pro has no medium: the nearest below.
    expect(
      buildReasoningProviderOptions(
        'gemini',
        modelWith(budget('medium'), 'gemini-3.1-pro-preview')
      )
    ).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } },
    })
    expect(
      buildReasoningProviderOptions(
        'google',
        modelWith(budget('medium'), 'gemini-2.5-flash')
      )
    ).toEqual({
      google: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: true } },
    })
    expect(
      buildReasoningProviderOptions(
        'google',
        modelWith(budget('xhigh'), 'gemini-2.5-pro')
      )
    ).toEqual({
      google: { thinkingConfig: { thinkingBudget: 32768, includeThoughts: true } },
    })
    // Off still wins.
    expect(
      buildReasoningProviderOptions(
        'google',
        modelWith(both('high', 'off'), 'gemini-3-pro')
      )
    ).toEqual({ google: { thinkingConfig: { thinkingBudget: 0 } } })
  })

  it('sends the subscription bridge reasoning_effort where its CLI takes one', () => {
    expect(
      buildReasoningBodyParams(
        'claude-cli',
        modelWith(budget('xhigh'), 'claude-opus-5-5')
      )
    ).toEqual({ reasoning_effort: 'xhigh' })
    expect(
      buildReasoningBodyParams(
        'claude-cli',
        modelWith(budget('xhigh'), 'claude-sonnet-5-5')
      )
    ).toEqual({ reasoning_effort: 'high' })
    expect(
      buildReasoningBodyParams('codex-cli', modelWith(budget('low'), 'gpt-6.1-sol'))
    ).toEqual({ reasoning_effort: 'low' })
    // No CLI switch for Gemini, none for Haiku, nothing when unset.
    expect(
      buildReasoningBodyParams('gemini-cli', modelWith(budget('high'), 'gemini-2.5-pro'))
    ).toBeUndefined()
    expect(
      buildReasoningBodyParams('claude-cli', modelWith(budget('high'), 'claude-haiku-4-5'))
    ).toBeUndefined()
    expect(
      buildReasoningBodyParams('claude-cli', modelWith({}, 'claude-opus-5-5'))
    ).toBeUndefined()
  })
})
