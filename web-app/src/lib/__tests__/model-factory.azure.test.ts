import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderObject } from '@janhq/core'

const h = vi.hoisted(() => ({ cfgs: [] as Array<Record<string, unknown>> }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => true,
  isPlatformIOS: () => false,
  isPlatformAndroid: () => false,
}))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((cfg: Record<string, unknown>) => {
    h.cfgs.push(cfg)
    return { languageModel: vi.fn(() => ({ type: 'openai-compatible' })) }
  }),
  OpenAICompatibleChatLanguageModel: vi.fn(),
  MetadataExtractor: vi.fn(),
}))
vi.mock('ai', () => ({
  wrapLanguageModel: vi.fn(({ model }) => model),
  extractReasoningMiddleware: vi.fn(() => ({})),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: { models: () => ({}) } }) },
}))

import {
  ModelFactory,
  isAzureOpenAIProvider,
  splitBaseUrlQuery,
} from '../model-factory'

const provider = (name: string, base_url: string): ProviderObject =>
  ({ provider: name, api_key: 'sk-az', base_url, models: [], settings: [], active: true }) as ProviderObject

describe('Azure OpenAI endpoints (janhq/jan#451)', () => {
  beforeEach(() => {
    h.cfgs.length = 0
    ;(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  it('detects the preset and Azure hosts only', () => {
    expect(isAzureOpenAIProvider(provider('azure', 'http://x'))).toBe(true)
    expect(isAzureOpenAIProvider(provider('custom', 'https://r.openai.azure.com/openai/v1'))).toBe(true)
    expect(isAzureOpenAIProvider(provider('custom', 'https://r.services.ai.azure.com/x'))).toBe(true)
    expect(isAzureOpenAIProvider(provider('custom', 'https://api.example.com/v1'))).toBe(false)
  })

  it('splits api-version out of the base URL', () => {
    expect(
      splitBaseUrlQuery('https://r.openai.azure.com/openai/deployments/x/?api-version=2024-10-21')
    ).toEqual({
      baseURL: 'https://r.openai.azure.com/openai/deployments/x',
      queryParams: { 'api-version': '2024-10-21' },
    })
    expect(splitBaseUrlQuery('https://r.openai.azure.com/openai/v1')).toEqual({
      baseURL: 'https://r.openai.azure.com/openai/v1',
    })
  })

  it('sends api-key beside Bearer and passes api-version as a query param', async () => {
    await ModelFactory.createModel(
      'dep',
      provider('azure', 'https://r.openai.azure.com/openai/deployments/dep?api-version=2024-10-21'),
      {}
    )
    const cfg = h.cfgs.at(-1)!
    expect(cfg.headers).toMatchObject({ Authorization: 'Bearer sk-az', 'api-key': 'sk-az' })
    expect(cfg.baseURL).toBe('https://r.openai.azure.com/openai/deployments/dep')
    expect(cfg.queryParams).toEqual({ 'api-version': '2024-10-21' })
  })

  it('leaves non-Azure providers untouched', async () => {
    await ModelFactory.createModel('m', provider('custom', 'https://api.example.com/v1'), {})
    const cfg = h.cfgs.at(-1)!
    expect((cfg.headers as Record<string, string>)['api-key']).toBeUndefined()
    expect(cfg.queryParams).toBeUndefined()
  })
})
