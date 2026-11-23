/**
 * Which API each OpenAI-style provider's model is built on: provider type x
 * host x model id x the per-model override, and the one-shot switch when the
 * first API's endpoint is missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderObject } from '@janhq/core'

const h = vi.hoisted(() => ({
  compatible: vi.fn(),
  responses: vi.fn(),
  chat: vi.fn(),
  remember: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => true,
  isPlatformIOS: () => false,
  isPlatformAndroid: () => false,
}))
vi.mock('@/lib/apiFormatMemory', () => ({
  rememberApiFormat: (...a: unknown[]) => h.remember(...a),
}))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((cfg: never) => {
    h.compatible(cfg)
    return {
      languageModel: vi.fn(() => ({
        type: 'compatible',
        specificationVersion: 'v3',
        provider: 'p',
        modelId: 'm',
        supportedUrls: {},
        doStream: vi.fn(async () => ({ stream: 'chat-stream' })),
        doGenerate: vi.fn(async () => ({ content: [] })),
      })),
    }
  }),
  OpenAICompatibleChatLanguageModel: vi.fn(),
  MetadataExtractor: vi.fn(),
}))
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  wrapLanguageModel: ({ model }: { model: unknown }) => model,
}))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const fn = vi.fn(() => ({ type: 'openai' })) as unknown as Record<string, unknown>
    fn.chat = h.chat
    fn.responses = h.responses
    return fn
  }),
}))

import { ModelFactory } from '../model-factory'

const OPENAI = 'https://api.openai.com/v1'
const GATEWAY = 'https://ai.kewaii.com/v1'
const AZURE_V1 = 'https://res.openai.azure.com/openai/v1'
const AZURE_LEGACY =
  'https://res.openai.azure.com/openai/deployments/d?api-version=2024-10-21'

const make = (
  providerName: string,
  base_url: string | undefined,
  model: Record<string, unknown> = {}
) =>
  ({
    provider: providerName,
    base_url,
    api_key: 'sk-test',
    settings: [],
    models: [{ id: 'm', ...model }],
  }) as unknown as ProviderObject

type Used = 'responses' | 'chat-sdk' | 'compatible'
const used = (): Used[] => [
  ...(h.responses.mock.calls.length ? (['responses'] as const) : []),
  ...(h.chat.mock.calls.length ? (['chat-sdk'] as const) : []),
  ...(h.compatible.mock.calls.length ? (['compatible'] as const) : []),
]

beforeEach(() => {
  h.compatible.mockClear()
  h.responses.mockReset().mockImplementation(() => ({ type: 'responses' }))
  h.chat.mockReset().mockImplementation(() => ({ type: 'chat' }))
  h.remember.mockClear()
})

describe('automatic choice', () => {
  const cases: Array<[string, string, string | undefined, string, Used]> = [
    ['openai preset, blank url', 'openai', undefined, 'gpt-5', 'responses'],
    ['openai preset, api.openai.com', 'openai', OPENAI, 'gpt-5', 'responses'],
    ['openai preset, gateway url', 'openai', GATEWAY, 'qwen3.8-flash-next-swift', 'compatible'],
    ['openai preset, gateway, responses-only id', 'openai', GATEWAY, 'gpt-5-pro', 'responses'],
    ['custom provider, gateway', 'kewaii', GATEWAY, 'qwen3.8-uncensored', 'compatible'],
    ['custom provider, gateway, codex id', 'kewaii', GATEWAY, 'openai/gpt-5-codex', 'responses'],
    ['custom provider on api.openai.com', 'mine', OPENAI, 'gpt-5', 'responses'],
    ['requesty', 'requesty', 'https://router.requesty.ai/v1', 'gpt-5', 'compatible'],
    ['litellm', 'litellm', 'http://localhost:4000/v1', 'gpt-5', 'compatible'],
    ['groq', 'groq', 'https://api.groq.com/openai/v1', 'llama', 'compatible'],
    ['deepseek', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-chat', 'compatible'],
    ['azure v1', 'azure', AZURE_V1, 'gpt-5', 'responses'],
    ['azure legacy deployments', 'azure', AZURE_LEGACY, 'gpt-5', 'compatible'],
  ]
  it.each(cases)('%s', async (_n, name, url, id, expected) => {
    await ModelFactory.createModel(id, make(name, url, { id }))
    expect(used()).toEqual([expected])
  })
})

describe('per-model override', () => {
  const cases: Array<[string, string, string | undefined, string, Used]> = [
    ['chat on OpenAI uses the SDK chat model', 'openai', OPENAI, 'chat', 'chat-sdk'],
    ['chat on a gateway uses the compatible route', 'openai', GATEWAY, 'chat', 'compatible'],
    ['responses on a gateway', 'openai', GATEWAY, 'responses', 'responses'],
    ['responses on a custom provider', 'kewaii', GATEWAY, 'responses', 'responses'],
    ['responses on requesty', 'requesty', 'https://router.requesty.ai/v1', 'responses', 'responses'],
    ['responses on litellm', 'litellm', 'http://localhost:4000/v1', 'responses', 'responses'],
    ['chat on azure v1', 'azure', AZURE_V1, 'chat', 'chat-sdk'],
    ['responses on azure legacy is refused', 'azure', AZURE_LEGACY, 'responses', 'compatible'],
  ]
  it.each(cases)('%s', async (_n, name, url, apiFormat, expected) => {
    await ModelFactory.createModel('gpt-5-pro', make(name, url, { id: 'gpt-5-pro', apiFormat }))
    expect(used()).toEqual([expected])
  })

  it('auto is the same as no setting', async () => {
    await ModelFactory.createModel('m', make('openai', GATEWAY, { apiFormat: 'auto' }))
    expect(used()).toEqual(['compatible'])
  })

  it('a detected format wins over the host and the id hint', async () => {
    await ModelFactory.createModel(
      'gpt-5-pro',
      make('openai', GATEWAY, { id: 'gpt-5-pro', detectedApiFormat: 'chat' })
    )
    expect(used()).toEqual(['compatible'])
  })

  it('the setting of one model does not leak to another', async () => {
    const p = {
      ...make('openai', GATEWAY),
      models: [
        { id: 'a', apiFormat: 'responses' },
        { id: 'b' },
      ],
    } as unknown as ProviderObject
    await ModelFactory.createModel('b', p)
    expect(used()).toEqual(['compatible'])
  })
})

describe('self-healing', () => {
  const missing = Object.assign(new Error('Unknown endpoint'), {
    statusCode: 404,
    url: `${GATEWAY}/responses`,
  })

  it('retries on Chat when /responses is missing and remembers it', async () => {
    h.responses.mockImplementation(() => ({
      doStream: vi.fn().mockRejectedValue(missing),
      doGenerate: vi.fn().mockRejectedValue(missing),
    }))
    h.compatible.mockClear()
    const model = await ModelFactory.createModel(
      'gpt-5-pro',
      make('openai', GATEWAY, { id: 'gpt-5-pro' })
    )
    await expect(
      (model as unknown as { doStream: (o: unknown) => Promise<unknown> }).doStream({
        prompt: [],
      })
    ).resolves.toBeTruthy()
    expect(h.compatible).toHaveBeenCalled()
    expect(h.remember).toHaveBeenCalledWith('openai', 'gpt-5-pro', 'chat', 'responses')
  })

  it('does not wrap a forced format', async () => {
    const model = (await ModelFactory.createModel(
      'm',
      make('openai', GATEWAY, { apiFormat: 'responses' })
    )) as unknown as { type: string }
    expect(model.type).toBe('responses')
  })
})
