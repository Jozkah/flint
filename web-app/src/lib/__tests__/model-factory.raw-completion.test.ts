import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ModelFactory } from '../model-factory'
import type { ProviderObject } from '@janhq/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('@/lib/providerFetch', () => ({
  providerFetch: vi.fn(),
  runtimeProviderFetch: vi.fn(),
  hasTauriRuntime: vi.fn(() => true),
  endpointDiagnostics: vi.fn(async () => null),
  refreshEndpoint: vi.fn(async () => undefined),
  endpointOf: vi.fn(() => null),
}))

vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  findSessionByModel: vi.fn(async () => ({ port: 8123, api_key: 'k' })),
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(),
  OpenAICompatibleChatLanguageModel: vi
    .fn()
    .mockImplementation(() => ({ type: 'chat' })),
  OpenAICompatibleCompletionLanguageModel: vi
    .fn()
    .mockImplementation(() => ({ type: 'completion' })),
}))

vi.mock('ai', () => ({
  wrapLanguageModel: vi.fn(({ model }) => model),
  extractReasoningMiddleware: vi.fn(() => ({})),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: {
    getState: () => ({
      serviceHub: {
        models: () => ({ startModel: vi.fn().mockResolvedValue(undefined) }),
      },
    }),
  },
}))

import {
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleCompletionLanguageModel,
} from '@ai-sdk/openai-compatible'

const provider = (capabilities: string[]) =>
  ({
    provider: 'llamacpp',
    base_url: '',
    models: [{ id: 'gpt2', capabilities }],
  }) as unknown as ProviderObject

describe('llamacpp raw-completion routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the completion model for a raw_completion model', async () => {
    const model = await ModelFactory.createModel(
      'gpt2',
      provider(['raw_completion'])
    )
    expect(model).toEqual({ type: 'completion' })
    expect(OpenAICompatibleCompletionLanguageModel).toHaveBeenCalledTimes(1)
    expect(OpenAICompatibleChatLanguageModel).not.toHaveBeenCalled()
  })

  it('keeps the chat model for an ordinary model', async () => {
    const model = await ModelFactory.createModel('gpt2', provider(['tools']))
    expect(model).toEqual({ type: 'chat' })
    expect(OpenAICompatibleCompletionLanguageModel).not.toHaveBeenCalled()
  })
})
