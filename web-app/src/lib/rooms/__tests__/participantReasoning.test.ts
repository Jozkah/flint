import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ nCtx: undefined as number | undefined }))
vi.mock('@/lib/llamacppRouterProps', () => ({
  getLlamacppExtension: () => ({
    getModelProps: async () => (h.nCtx ? { nCtx: h.nCtx } : undefined),
  }),
}))

import {
  applicableParticipantReasoning,
  buildParticipantReasoningRequest,
  normaliseParticipantReasoning,
  participantReasoningControls,
} from '../participantReasoning'

const model = (over: Partial<Model> = {}) =>
  ({ id: 'm', settings: {}, ...over }) as Model

describe('participant reasoning request', () => {
  beforeEach(() => {
    h.nCtx = undefined
  })

  it('sends nothing for a participant left at the model default', async () => {
    for (const p of ['llamacpp', 'openai', 'anthropic', 'google']) {
      expect(await buildParticipantReasoningRequest(p, model(), 'm', undefined, 1024)).toEqual({
        params: {},
      })
    }
  })

  it('llama.cpp: resolves the level against the live context and clamps it like chat', async () => {
    h.nCtx = 65536
    // Medium = 25% of the live 65536-token context, under the 0.8 output cap.
    expect(
      await buildParticipantReasoningRequest('llamacpp', model(), 'm', { level: 'medium' }, 32768)
    ).toEqual({ params: { thinking_budget_tokens: 16384 } })
    // Capped at 80% of the turn's output limit.
    expect(
      await buildParticipantReasoningRequest('llamacpp', model(), 'm', { level: 'medium' }, 4096)
    ).toEqual({ params: { thinking_budget_tokens: 3276 } })
    // Unlimited (-1) is capped the same way; never below the 1024 floor.
    expect(
      await buildParticipantReasoningRequest('llamacpp', model(), 'm', { level: 'unlimited' }, 1024)
    ).toEqual({ params: { thinking_budget_tokens: 1024 } })
  })

  it('llama.cpp: falls back to the configured context, and maps On/Off to enable_thinking', async () => {
    const configured = model({
      settings: { ctx_len: { controller_props: { value: 20000 } } } as never,
    })
    expect(
      await buildParticipantReasoningRequest(
        'llamacpp',
        configured,
        'm',
        { mode: 'off', level: 'low' },
        8192
      )
    ).toEqual({
      params: { chat_template_kwargs: { enable_thinking: false }, thinking_budget_tokens: 2000 },
    })
    expect(
      await buildParticipantReasoningRequest('llamacpp', configured, 'm', { mode: 'auto' }, 8192)
    ).toEqual({ params: {} })
  })

  it('never sends a token budget to a provider that does not take one', async () => {
    const google = await buildParticipantReasoningRequest(
      'google',
      model(),
      'm',
      { mode: 'off', level: 'high' },
      8192
    )
    expect(google.params).toEqual({})
    expect(google.providerOptions).toEqual({ google: { thinkingConfig: { thinkingBudget: 0 } } })

    const compatible = await buildParticipantReasoningRequest(
      'openrouter',
      model({ capabilities: ['reasoning'] }),
      'm',
      { level: 'xhigh' },
      8192
    )
    expect(compatible).toEqual({ params: { reasoning_effort: 'xhigh' } })

    // A provider none of the mappings reach gets nothing at all.
    expect(
      await buildParticipantReasoningRequest('mistral', model(), 'm', { mode: 'on', level: 'high' }, 8192)
    ).toEqual({ params: {} })
  })

  it('drops what the current model would not act on', () => {
    // Anthropic 4.6+ sizes its own thinking: no effort levels.
    expect(
      applicableParticipantReasoning('anthropic', model({ id: 'claude-sonnet-4-6' }), {
        level: 'high',
      })
    ).toBeUndefined()
    expect(
      applicableParticipantReasoning('anthropic', model({ id: 'claude-sonnet-4-6' }), {
        mode: 'on',
        level: 'high',
      })
    ).toEqual({ mode: 'on' })
    expect(participantReasoningControls('llamacpp', model())).toEqual({
      modes: true,
      thinkingBudget: true,
      effortLevels: [],
    })
    expect(normaliseParticipantReasoning({ mode: 'loud', level: 'huge' })).toBeUndefined()
  })
})
