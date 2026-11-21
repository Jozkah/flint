/**
 * An `openai` provider pointed at a gateway (a custom Base URL) must use chat
 * completions: most gateways have no /responses route and answer "Unknown
 * endpoint". The genuine OpenAI endpoint keeps the Responses API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderObject } from '@janhq/core'

const h = vi.hoisted(() => ({
  compatible: vi.fn(),
  responses: vi.fn(() => ({ type: 'responses' })),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => true,
  isPlatformIOS: () => false,
  isPlatformAndroid: () => false,
}))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((cfg: never) => {
    h.compatible(cfg)
    return { languageModel: vi.fn(() => ({ type: 'openai-compatible' })) }
  }),
  OpenAICompatibleChatLanguageModel: vi.fn(),
  MetadataExtractor: vi.fn(),
}))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const fn = vi.fn(() => ({ type: 'openai' })) as unknown as Record<string, unknown>
    fn.chat = vi.fn(() => ({ type: 'chat' }))
    fn.responses = h.responses
    return fn
  }),
}))

import { ModelFactory, usesCustomOpenAIEndpoint } from '../model-factory'

const provider = (base_url: string) =>
  ({
    provider: 'openai',
    base_url,
    api_key: 'sk-test',
    settings: [],
    models: [],
  }) as unknown as ProviderObject

beforeEach(() => {
  h.compatible.mockClear()
  h.responses.mockClear()
})

describe('usesCustomOpenAIEndpoint', () => {
  it('treats blank and api.openai.com as the genuine service', () => {
    expect(usesCustomOpenAIEndpoint(undefined)).toBe(false)
    expect(usesCustomOpenAIEndpoint('  ')).toBe(false)
    expect(usesCustomOpenAIEndpoint('https://api.openai.com/v1')).toBe(false)
  })
  it('treats any other host as a gateway', () => {
    expect(usesCustomOpenAIEndpoint('https://ai.kewaii.com/v1')).toBe(true)
    expect(usesCustomOpenAIEndpoint('http://localhost:4000/v1')).toBe(true)
  })
})

describe('ModelFactory.createModel for the openai provider', () => {
  it('uses chat completions on a custom Base URL', async () => {
    await ModelFactory.createModel('gpt-x', provider('https://ai.kewaii.com/v1'))
    expect(h.compatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://ai.kewaii.com/v1' })
    )
    expect(h.responses).not.toHaveBeenCalled()
  })

  it('keeps the Responses API on OpenAI itself', async () => {
    await ModelFactory.createModel('gpt-x', provider('https://api.openai.com/v1'))
    expect(h.responses).toHaveBeenCalledWith('gpt-x')
    expect(h.compatible).not.toHaveBeenCalled()
  })
})
