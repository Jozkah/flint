import { describe, expect, it, vi } from 'vitest'
import { defaultEffort, effortProfile } from '../modelEffort'
import {
  buildReasoningBodyParams,
  buildReasoningProviderOptions,
} from '../reasoningProviderOptions'
import { withReasoningRejectionRetry } from '../reasoningRejection'

const model = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, capabilities: ['completion'], ...extra }) as unknown as Model

const off = { reasoning: { controller_props: { value: 'off' } } }
const picked = (value: string) => ({
  thinking_budget_tokens: { controller_props: { value } },
})

describe('defaultEffort', () => {
  it('is medium for OpenAI reasoning ids and nothing for the others', () => {
    expect(defaultEffort('openai', model('gpt-5'))).toBe('medium')
    expect(defaultEffort('openai', model('o3'))).toBe('medium')
    expect(defaultEffort('openai', model('gpt-4o'))).toBeNull()
    expect(defaultEffort('openai', model('gpt-4.1-mini'))).toBeNull()
  })

  it('uses the family default for Anthropic and Gemini, none when unknown', () => {
    expect(defaultEffort('anthropic', model('claude-opus-4-7'))).toBe('high')
    expect(defaultEffort('anthropic', model('claude-sonnet-4-5'))).toBe('medium')
    expect(defaultEffort('anthropic', model('claude-3-5-haiku-latest'))).toBeNull()
    expect(defaultEffort('google', model('gemini-3-pro'))).toBe('high')
    expect(defaultEffort('google', model('gemini-2.0-flash'))).toBeNull()
  })

  it('sends nothing for an unknown compatible model, medium once it reasons', () => {
    expect(defaultEffort('requesty', model('acme-chat-7b'))).toBeNull()
    expect(
      defaultEffort('requesty', model('acme-chat-7b', { capabilities: ['reasoning'] }))
    ).toBe('medium')
    expect(defaultEffort('openrouter', model('qwen3-235b'))).toBe('medium')
  })

  it('is never sent for local engines or the subscription bridges', () => {
    expect(defaultEffort('llamacpp', model('qwen3-4b'))).toBeNull()
    expect(defaultEffort('mlx', model('qwen3-4b'))).toBeNull()
    expect(defaultEffort('codex-cli', model('gpt-5'))).toBeNull()
    expect(defaultEffort('claude-cli', model('claude-opus-4-7'))).toBeNull()
  })

  it('honours the user default, clamped, and "none"', () => {
    expect(defaultEffort('openai', model('gpt-5', { defaultEffort: 'low' }))).toBe(
      'low'
    )
    // gpt-5 tops out at high
    expect(defaultEffort('openai', model('gpt-5', { defaultEffort: 'xhigh' }))).toBe(
      'high'
    )
    expect(defaultEffort('openai', model('gpt-5', { defaultEffort: 'none' }))).toBeNull()
    // an explicit default also applies to a bridge
    expect(
      defaultEffort('codex-cli', model('gpt-5', { defaultEffort: 'high' }))
    ).toBe('high')
  })

  it('stays off once the server refused the parameter', () => {
    expect(
      defaultEffort('requesty', model('qwen3-235b', { reasoningRejected: true }))
    ).toBeNull()
  })

  it('a declared list replaces the family list and qualifies a compatible host', () => {
    const declared = model('acme-chat-7b', { reasoningEfforts: ['low', 'high'] })
    expect(effortProfile('requesty', declared).levels).toEqual(['low', 'high'])
    expect(defaultEffort('requesty', declared)).toBe('low')
    expect(
      effortProfile('openai', model('gpt-5', { reasoningEfforts: ['low'] })).levels
    ).toEqual(['low'])
    // a provider with no effort wiring ignores the list
    expect(
      effortProfile('google', model('gemini-2.0-flash', { reasoningEfforts: ['low'] }))
        .levels
    ).toEqual([])
  })
})

describe('the default reaches each provider path', () => {
  it('OpenAI: reasoningEffort with a summary, so it streams on Responses', () => {
    expect(buildReasoningProviderOptions('openai', model('gpt-5'))).toEqual({
      openai: { reasoningEffort: 'medium', reasoningSummary: 'auto' },
    })
    expect(buildReasoningProviderOptions('openai', model('gpt-4o'))).toBeUndefined()
  })

  it('Anthropic: adaptive thinking with the effort, a budget before 4.6', () => {
    expect(
      buildReasoningProviderOptions('anthropic', model('claude-opus-4-7'))
    ).toEqual({
      anthropic: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'high',
      },
    })
    expect(
      buildReasoningProviderOptions('anthropic', model('claude-sonnet-4-5'))
    ).toMatchObject({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } },
    })
  })

  it('Gemini: a thinking level with thoughts included', () => {
    expect(buildReasoningProviderOptions('google', model('gemini-3-pro'))).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } },
    })
  })

  it('compatible hosts: reasoning_effort in the body', () => {
    expect(buildReasoningBodyParams('requesty', model('qwen3-235b'))).toEqual({
      reasoning_effort: 'medium',
    })
    expect(
      buildReasoningBodyParams('requesty', model('acme-chat-7b'))
    ).toBeUndefined()
    // flash-next templates skip `high`
    expect(
      buildReasoningBodyParams('gateway', model('qwen3.8-flash-next-uncensored'))
    ).toEqual({ reasoning_effort: 'medium' })
  })

  it('an explicit choice beats the default, "unlimited" and off send none', () => {
    expect(
      buildReasoningBodyParams(
        'requesty',
        model('qwen3-235b', { settings: picked('low') })
      )
    ).toEqual({ reasoning_effort: 'low' })
    expect(
      buildReasoningBodyParams(
        'requesty',
        model('qwen3-235b', { settings: picked('unlimited') })
      )
    ).toBeUndefined()
    expect(
      buildReasoningBodyParams('requesty', model('qwen3-235b', { settings: off }))
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    expect(
      buildReasoningProviderOptions('openai', model('gpt-5.1', { settings: off }))
    ).toEqual({ openai: { reasoningEffort: 'none' } })
    // gpt-5 cannot be disabled: off sends nothing rather than the default
    expect(
      buildReasoningProviderOptions('openai', model('gpt-5', { settings: off }))
    ).toBeUndefined()
  })
})

describe('withReasoningRejectionRetry', () => {
  const chat = 'https://host.test/v1/chat/completions'
  const reply = (status: number, text = '') => new Response(text, { status })

  it('retries once without the effort when the server blames it, and reports', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const base = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      bodies.push(body)
      return 'reasoning_effort' in body
        ? reply(400, '{"error":"Unknown parameter: reasoning_effort"}')
        : reply(200, 'ok')
    })
    const onRejected = vi.fn()
    const f = withReasoningRejectionRetry(
      base as unknown as typeof fetch,
      onRejected
    )
    const res = await f(chat, {
      method: 'POST',
      body: JSON.stringify({ model: 'm', reasoning_effort: 'medium' }),
    })
    expect(res.status).toBe(200)
    expect(bodies).toEqual([
      { model: 'm', reasoning_effort: 'medium' },
      { model: 'm' },
    ])
    expect(onRejected).toHaveBeenCalledTimes(1)
  })

  it('leaves other failures, other bodies and other URLs alone', async () => {
    const onRejected = vi.fn()
    const base = vi.fn(async () => reply(400, 'context length exceeded'))
    const f = withReasoningRejectionRetry(
      base as unknown as typeof fetch,
      onRejected
    )
    const withEffort = JSON.stringify({ reasoning_effort: 'low' })
    expect((await f(chat, { method: 'POST', body: withEffort })).status).toBe(400)
    expect(
      (await f(chat, { method: 'POST', body: JSON.stringify({ model: 'm' }) })).status
    ).toBe(400)
    expect(
      (await f('https://host.test/v1/embeddings', { method: 'POST', body: withEffort }))
        .status
    ).toBe(400)
    expect(base).toHaveBeenCalledTimes(3)
    expect(onRejected).not.toHaveBeenCalled()
  })
})
