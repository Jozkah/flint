import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { ModelFactory, isAzureV1Endpoint } from '../model-factory'

// Azure reasoning deployments reject function tools on /chat/completions, so
// the v1 endpoint must use the Responses API. These tests drive the real AI SDK
// and only stub the network, so they assert on the request that would leave.

const V1 = 'https://my-resource.openai.azure.com/openai/v1'

const provider = (
  name: string,
  base_url: string
): ProviderObject =>
  ({
    provider: name,
    api_key: 'test-key',
    base_url,
    models: [],
    settings: [],
  }) as unknown as ProviderObject

const callWithTool = (model: LanguageModelV3) =>
  model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'time?' }] }],
    tools: [
      {
        type: 'function',
        name: 'get_time',
        description: 'Returns the current time',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  })

describe('ModelFactory - Azure request routing', () => {
  const fetchMock = vi.fn<typeof globalThis.fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'stubbed' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const sentUrl = () => {
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input] = fetchMock.mock.calls[0]
    return typeof input === 'string' ? input : (input as Request).url
  }

  it('detects the v1 endpoint only', () => {
    expect(isAzureV1Endpoint(V1)).toBe(true)
    expect(
      isAzureV1Endpoint(
        'https://r.openai.azure.com/openai/deployments/d?api-version=2024-10-21'
      )
    ).toBe(false)
    expect(isAzureV1Endpoint('https://r.openai.azure.com/openai/deployments/d')).toBe(false)
    expect(isAzureV1Endpoint('')).toBe(false)
  })

  it('sends Azure v1 requests with function tools to the Responses API', async () => {
    const model = (await ModelFactory.createModel(
      'gpt-6.1-sol',
      provider('azure', V1)
    )) as LanguageModelV3

    await expect(callWithTool(model)).rejects.toThrow()

    expect(sentUrl()).toBe(`${V1}/responses`)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body ?? '{}'))
    expect(body.model).toBe('gpt-6.1-sol')
  })

  it('keeps legacy deployments endpoints on Chat Completions', async () => {
    const model = (await ModelFactory.createModel(
      'dep',
      provider(
        'azure',
        'https://r.openai.azure.com/openai/deployments/dep?api-version=2024-10-21'
      )
    )) as LanguageModelV3

    await expect(callWithTool(model)).rejects.toThrow()

    expect(sentUrl()).toContain('/openai/deployments/dep/chat/completions')
  })

  it('keeps other OpenAI-compatible providers on Chat Completions', async () => {
    const model = (await ModelFactory.createModel(
      'llama-3.3-70b',
      provider('groq', 'https://api.groq.com/openai/v1')
    )) as LanguageModelV3

    await expect(callWithTool(model)).rejects.toThrow()

    expect(sentUrl()).toBe('https://api.groq.com/openai/v1/chat/completions')
  })
})
