/**
 * Wire-level check of every built-in remote provider preset: the real AI SDK
 * clients are used, only `fetch` is replaced by a recorder, so what is asserted
 * is the exact URL, auth header and body a request would carry. No network.
 *
 * What this cannot prove: that the remote service accepts the request. That
 * needs a real key per provider (see the report that came with this test).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import type { ProviderObject } from '@janhq/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: { models: () => ({}) } }) },
}))

import { ModelFactory } from '../model-factory'
import { predefinedProviders } from '@/constants/providers'

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
let calls: Captured[] = []

const chatReply = {
  id: 'x',
  object: 'chat.completion',
  created: 1,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v))
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(String(init?.body ?? '{}'))
      } catch {
        // not JSON
      }
      calls.push({ url: String(input), headers, body })
      return new Response(JSON.stringify(chatReply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
  )
})

const preset = (name: string): ProviderObject => {
  const p = predefinedProviders.find((x) => x.provider === name)
  if (!p) throw new Error(`no preset ${name}`)
  return { ...(p as unknown as ProviderObject), api_key: 'KEY' }
}

async function send(provider: ProviderObject, model = 'm1'): Promise<Captured> {
  const lm = await ModelFactory.createModel(model, provider, {})
  try {
    await generateText({ model: lm, prompt: 'hello', maxRetries: 0 })
  } catch {
    // The stub reply is chat-shaped; a native client may reject it. The
    // request is what is under test.
  }
  expect(calls.length).toBeGreaterThan(0)
  return calls[0]!
}

describe('OpenAI-compatible presets build /chat/completions with a Bearer key', () => {
  it.each([
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
    ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
    ['deepseek', 'https://api.deepseek.com/chat/completions'],
    ['perplexity', 'https://api.perplexity.ai/chat/completions'],
    ['fireworks', 'https://api.fireworks.ai/inference/v1/chat/completions'],
    ['nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions'],
    ['together', 'https://api.together.ai/v1/chat/completions'],
  ])('%s', async (name, expectedUrl) => {
    const p = preset(name)
    expect(p.base_url.replace(/\/$/, '') + '/chat/completions').toBe(expectedUrl)
    const req = await send(p)
    expect(req.url).toBe(expectedUrl)
    expect(req.headers['authorization']).toBe('Bearer KEY')
    expect(req.body.model).toBe('m1')
    expect(Array.isArray(req.body.messages)).toBe(true)
  })

  it('cohere preset base_url is its OpenAI-compat route', async () => {
    const p = preset('cohere')
    const req = await send(p)
    expect(req.url).toBe(`${p.base_url.replace(/\/$/, '')}/chat/completions`)
    expect(req.url.startsWith('https://api.cohere.')).toBe(true)
    expect(req.headers['authorization']).toBe('Bearer KEY')
  })
})

describe('Gemini preset', () => {
  it('stores the native base URL, not the OpenAI shim the factory had to strip', () => {
    expect(preset('gemini').base_url).toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  it('goes to the native generateContent route with x-goog-api-key', async () => {
    const req = await send(preset('gemini'), 'gemini-2.5-flash')
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    )
    expect(req.headers['x-goog-api-key']).toBe('KEY')
  })

  it('still copes with a base URL saved before this change (…/v1beta/openai)', async () => {
    const legacy = {
      ...preset('gemini'),
      base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }
    const req = await send(legacy, 'gemini-2.5-flash')
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    )
  })
})

describe('Azure preset', () => {
  const azure = (base_url: string, extra: Partial<ProviderObject> = {}): ProviderObject => ({
    ...preset('azure'),
    base_url,
    ...extra,
  })

  it('v1 endpoint: Responses API, key sent', async () => {
    const req = await send(azure('https://r.openai.azure.com/openai/v1'), 'dep')
    expect(req.url).toBe('https://r.openai.azure.com/openai/v1/responses')
    expect(req.headers['authorization']).toBe('Bearer KEY')
  })

  it('deployments endpoint with api-version in the URL: query kept, api-key header set', async () => {
    const req = await send(
      azure('https://r.openai.azure.com/openai/deployments/dep?api-version=2024-10-21'),
      'dep'
    )
    expect(req.url).toBe(
      'https://r.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2024-10-21'
    )
    expect(req.headers['api-key']).toBe('KEY')
  })

  it('deployments endpoint without api-version uses the api-version setting', async () => {
    const withSetting = azure('https://r.openai.azure.com/openai/deployments/dep', {
      settings: preset('azure').settings.map((st) =>
        st.key === 'api-version'
          ? { ...st, controller_props: { ...st.controller_props, value: '2025-01-01-preview' } }
          : st
      ) as ProviderObject['settings'],
    })
    const req = await send(withSetting, 'dep')
    expect(req.url).toBe(
      'https://r.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2025-01-01-preview'
    )
  })

  it('an api-version already typed in the URL wins over the setting', async () => {
    const both = azure(
      'https://r.openai.azure.com/openai/deployments/dep?api-version=2024-10-21',
      {
        settings: [
          {
            key: 'api-version',
            title: 'API version',
            description: '',
            controller_type: 'input',
            controller_props: { value: '2099-01-01' },
          },
        ] as ProviderObject['settings'],
      }
    )
    const req = await send(both, 'dep')
    expect(req.url).toContain('api-version=2024-10-21')
    expect(req.url).not.toContain('2099')
  })

  it('the preset declares the api-version field', () => {
    expect(preset('azure').settings.map((s) => s.key)).toContain('api-version')
  })
})

describe('custom endpoint', () => {
  it('works with no key: no Authorization header is sent', async () => {
    const custom = {
      provider: 'my-llm',
      api_key: '',
      base_url: 'http://localhost:8080/v1',
      models: [],
      settings: [],
      active: true,
    } as unknown as ProviderObject
    const req = await send(custom)
    expect(req.url).toBe('http://localhost:8080/v1/chat/completions')
    expect(req.headers['authorization']).toBeUndefined()
  })

  it('a remote custom endpoint with no key also builds (keyless gateway)', async () => {
    const custom = {
      provider: 'gateway',
      api_key: '',
      base_url: 'https://llm.example.com/v1',
      models: [],
      settings: [],
      active: true,
    } as unknown as ProviderObject
    const req = await send(custom)
    expect(req.url).toBe('https://llm.example.com/v1/chat/completions')
    expect(req.headers['authorization']).toBeUndefined()
  })
})

describe('model-list auth header', () => {
  it('Gemini native base uses x-goog-api-key, the OpenAI shim keeps Bearer', async () => {
    const { applyProviderAuthHeader } = await import('../anthropicHeaders')
    const native: Record<string, string> = {}
    applyProviderAuthHeader(preset('gemini'), native, 'K')
    expect(native).toEqual({ 'x-goog-api-key': 'K' })
    const shim: Record<string, string> = {}
    applyProviderAuthHeader(
      { provider: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      shim,
      'K'
    )
    expect(shim).toEqual({ Authorization: 'Bearer K' })
  })
})
