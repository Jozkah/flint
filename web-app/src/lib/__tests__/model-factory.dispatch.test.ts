/**
 * The conversation a remote request belongs to must reach the provider
 * transport as `x-jan-session`, whichever SDK the provider is built on and
 * whichever branch of `ModelFactory.createModel` builds it. The transport
 * files the "what the model received" snapshot against that header; without
 * it the snapshot is dropped and a warning is logged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderObject } from '@janhq/core'

const h = vi.hoisted(() => ({
  fetches: [] as Array<typeof globalThis.fetch>,
  sent: [] as Array<{ url: string; init: RequestInit }>,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => true,
  isPlatformIOS: () => false,
  isPlatformAndroid: () => false,
}))
vi.mock('@/lib/providerFetch', () => ({
  providerFetch: vi.fn(async (url: unknown, init: RequestInit) => {
    h.sent.push({ url: String(url), init })
    return new Response('{}', { status: 200 })
  }),
  runtimeProviderFetch: vi.fn(),
  hasTauriRuntime: vi.fn(() => true),
  endpointDiagnostics: vi.fn(async () => null),
  refreshEndpoint: vi.fn(async () => undefined),
  endpointOf: vi.fn(() => null),
}))

const capture = (cfg: { fetch?: typeof globalThis.fetch }) => {
  if (cfg.fetch) h.fetches.push(cfg.fetch)
}

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((cfg: never) => {
    capture(cfg)
    return { languageModel: vi.fn(() => ({ type: 'openai-compatible' })) }
  }),
  OpenAICompatibleChatLanguageModel: vi.fn(),
  MetadataExtractor: vi.fn(),
}))
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn((cfg: never) => {
    capture(cfg)
    return vi.fn(() => ({ type: 'anthropic' }))
  }),
}))
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn((cfg: never) => {
    capture(cfg)
    return vi.fn(() => ({ type: 'google' }))
  }),
}))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((cfg: never) => {
    capture(cfg)
    const fn: any = vi.fn(() => ({ type: 'openai' }))
    fn.chat = vi.fn(() => ({ type: 'openai' }))
    fn.responses = vi.fn(() => ({ type: 'openai' }))
    return fn
  }),
}))
vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn((cfg: never) => {
    capture(cfg)
    return vi.fn(() => ({ type: 'xai' }))
  }),
}))
vi.mock('@ai-sdk/mistral', () => ({
  createMistral: vi.fn((cfg: never) => {
    capture(cfg)
    return vi.fn(() => ({ type: 'mistral' }))
  }),
}))
vi.mock('ai', () => ({
  wrapLanguageModel: vi.fn(({ model }) => model),
  extractReasoningMiddleware: vi.fn(() => ({})),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: { models: () => ({}) } }) },
}))

import { DISPATCH_PARAM_KEY, ModelFactory } from '../model-factory'

const provider = (name: string, extra: Partial<ProviderObject> = {}): ProviderObject =>
  ({
    provider: name,
    api_key: 'sk-test',
    base_url: 'http://192.168.1.5:8080/v1',
    models: [],
    settings: [],
    active: true,
    ...extra,
  }) as ProviderObject

const dispatch = { session: 'thread-42', run: 'req-1', provider: 'p' }

/** Build the model, then send one chat POST through the fetch the SDK got. */
async function sentHeaders(p: ProviderObject, params: Record<string, unknown>) {
  h.fetches.length = 0
  h.sent.length = 0
  await ModelFactory.createModel('m', p, params)
  const fetchImpl = h.fetches.at(-1)
  expect(fetchImpl, 'the SDK was given a fetch').toBeTruthy()
  await fetchImpl!('http://192.168.1.5:8080/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  expect(h.sent).toHaveLength(1)
  return new Headers(h.sent[0].init.headers as HeadersInit)
}

describe('the dispatch identity reaches the provider transport', () => {
  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  const withIdentity = { [DISPATCH_PARAM_KEY]: dispatch }

  it.each([
    'openai',
    'anthropic',
    'google',
    'gemini',
    'mistral',
    'xai',
    'my-lan-server',
    'groq',
    'deepseek',
    'together',
    'fireworks',
    'cohere',
    'perplexity',
    'moonshot',
    'minimax',
    'azure',
  ])('keeps x-jan-session for %s', async (name) => {
    const headers = await sentHeaders(provider(name), withIdentity)
    expect(headers.get('x-jan-session')).toBe('thread-42')
    expect(headers.get('x-jan-run')).toBe('req-1')
    expect(headers.get('x-jan-provider')).toBe('p')
  })

  it('keeps it through API key rotation', async () => {
    const headers = await sentHeaders(
      provider('my-lan-server', { api_key: 'a', api_keys: ['a', 'b'] } as never),
      withIdentity
    )
    expect(headers.get('x-jan-session')).toBe('thread-42')
  })

  it('keeps it for a custom provider speaking the Anthropic wire format', async () => {
    const headers = await sentHeaders(
      provider('proxy', { api_type: 'anthropic' } as never),
      withIdentity
    )
    expect(headers.get('x-jan-session')).toBe('thread-42')
  })

  it('never writes the identity into the request body', async () => {
    await sentHeaders(provider('groq'), withIdentity)
    expect(String(h.sent[0].init.body)).not.toContain('janDispatch')
  })

  it('sends no session for a call that has none (a utility call)', async () => {
    const headers = await sentHeaders(provider('my-lan-server'), {})
    expect(headers.get('x-jan-session')).toBeNull()
  })
})
