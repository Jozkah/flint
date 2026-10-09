/**
 * Deep coverage tests for model-factory.ts internal functions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/providerFetch', () => ({
  // Provider requests go through the canonical transport now; this is the
  // seam that used to be `@tauri-apps/plugin-http`.
  providerFetch: vi
    .fn()
    .mockImplementation(async () => new Response('{}', { status: 200 })),
  runtimeProviderFetch: vi.fn(),
  hasTauriRuntime: vi.fn(() => true),
  endpointDiagnostics: vi.fn(async () => null),
  refreshEndpoint: vi.fn(async () => undefined),
  endpointOf: vi.fn(() => null),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

vi.mock('@ai-sdk/openai-compatible', () => {
  const MCM = vi.fn().mockImplementation((_id: string, opts: any) => {
    ;(globalThis as any).__capturedModelOpts = opts
    return { type: 'openai-compatible', modelId: _id }
  })
  return {
    createOpenAICompatible: vi.fn(() => ({
      languageModel: vi.fn(() => ({ type: 'openai-compatible' })),
    })),
    OpenAICompatibleChatLanguageModel: MCM,
    MetadataExtractor: vi.fn(),
  }
})

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ type: 'anthropic' }))),
}))

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn((config: any) => {
    ;(globalThis as any).__capturedGoogleCfg = config
    return vi.fn(() => ({ type: 'google' }))
  }),
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((config: any) => {
    ;(globalThis as any).__capturedOpenAICfg = config
    const fn: any = vi.fn(() => ({ type: 'openai' }))
    fn.chat = vi.fn(() => ({ type: 'openai' }))
    fn.responses = vi.fn(() => ({ type: 'openai' }))
    return fn
  }),
}))

vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn((config: any) => {
    ;(globalThis as any).__capturedXaiCfg = config
    return vi.fn(() => ({ type: 'xai' }))
  }),
}))

vi.mock('ai', () => ({
  wrapLanguageModel: vi.fn(({ model }) => model),
  extractReasoningMiddleware: vi.fn(() => ({})),
}))

const mockStartModel = vi.fn().mockResolvedValue(undefined)

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: {
    getState: () => ({
      serviceHub: {
        models: () => ({ startModel: (...args: any[]) => mockStartModel(...args) }),
      },
    }),
  },
}))

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: vi.fn(() => false),
}))

vi.mock('@/lib/provider-api-keys', () => ({
  providerRemoteApiKeyChain: vi.fn((p: any) => {
    const primary = p.api_key?.trim()
    const fallbacks = (p.api_key_fallbacks ?? [])
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 0)
    return [...(primary ? [primary] : []), ...fallbacks]
  }),
}))

import { ModelFactory, createCustomFetch } from '../model-factory'
import { invoke } from '@tauri-apps/api/core'
import { providerFetch as httpFetch } from '@/lib/providerFetch'

function getOpts(): any {
  return (globalThis as any).__capturedModelOpts
}

const mkProvider = (
  provider: string,
  overrides: Partial<ProviderObject> = {}
): ProviderObject =>
  ({
    provider,
    api_key: 'test-key',
    base_url: 'https://api.test.com/v1',
    ...overrides,
  }) as ProviderObject

describe('model-factory deep coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).__capturedModelOpts = null
    ;(globalThis as any).__capturedGoogleCfg = null
    ;(globalThis as any).__capturedOpenAICfg = null
    ;(globalThis as any).__capturedXaiCfg = null
    mockStartModel.mockResolvedValue(undefined)
  })

  /* providerMetadataExtractor */
  describe('providerMetadataExtractor', () => {
    async function getExtractor() {
      vi.mocked(invoke).mockResolvedValue({ port: 8080, api_key: 'k' })
      await ModelFactory.createModel('m', mkProvider('llamacpp'), {})
      return getOpts()?.metadataExtractor
    }

    it('extractMetadata returns timings when present', async () => {
      const ext = await getExtractor()
      const result = await ext.extractMetadata({
        parsedBody: {
          timings: { prompt_n: 10, predicted_n: 20, predicted_per_second: 50, prompt_per_second: 100 },
        },
      })
      expect(result.providerMetadata.promptTokens).toBe(10)
      expect(result.providerMetadata.completionTokens).toBe(20)
    })

    it('extractMetadata returns undefined when no timings', async () => {
      const ext = await getExtractor()
      expect(await ext.extractMetadata({ parsedBody: {} })).toBeUndefined()
    })

    it('extractMetadata handles missing fields in timings', async () => {
      const ext = await getExtractor()
      const result = await ext.extractMetadata({ parsedBody: { timings: {} } })
      expect(result.providerMetadata.promptTokens).toBe(0)
    })

    it('extractMetadata sums prompt_n and cache_n (KV-cache-reused tokens) into promptTokens', async () => {
      const ext = await getExtractor()
      const result = await ext.extractMetadata({
        parsedBody: { timings: { prompt_n: 21, cache_n: 200, predicted_n: 95 } },
      })
      expect(result.providerMetadata.promptTokens).toBe(221)
    })

    it('extractMetadata reports speculative draft acceptance only when a draft ran', async () => {
      const ext = await getExtractor()
      const withDraft = await ext.extractMetadata({
        parsedBody: { timings: { predicted_n: 90, draft_n: 40, draft_n_accepted: 30 } },
      })
      expect(withDraft.providerMetadata.draftTokens).toBe(40)
      expect(withDraft.providerMetadata.draftAccepted).toBe(30)
      const without = await ext.extractMetadata({
        parsedBody: { timings: { predicted_n: 90, draft_n: 0, draft_n_accepted: 0 } },
      })
      expect(without.providerMetadata.draftTokens).toBeUndefined()
      const none = await ext.extractMetadata({ parsedBody: { timings: { predicted_n: 90 } } })
      expect(none.providerMetadata.draftTokens).toBeUndefined()
    })

    it('createStreamExtractor processes chunks and builds metadata', async () => {
      const ext = await getExtractor()
      const s = ext.createStreamExtractor()
      s.processChunk({ timings: { prompt_n: 5, predicted_n: 15, predicted_per_second: 35, prompt_per_second: 65 } })
      const meta = s.buildMetadata()
      expect(meta.providerMetadata.completionTokens).toBe(15)
    })

    it('createStreamExtractor returns undefined with no timings', async () => {
      const ext = await getExtractor()
      const s = ext.createStreamExtractor()
      s.processChunk({})
      expect(s.buildMetadata()).toBeUndefined()
    })

    it('createStreamExtractor publishes live token stats globally and per-thread on every chunk', async () => {
      const { useAppState } = await import('@/hooks/useAppState')
      useAppState.getState().setCurrentStreamThreadId('thread-live')

      const ext = await getExtractor()
      const s = ext.createStreamExtractor()
      s.processChunk({
        timings: { prompt_n: 5, predicted_n: 15, predicted_per_second: 35, prompt_per_second: 65 },
      })

      expect(useAppState.getState().liveTokenStats).toEqual({
        promptTokens: 5,
        completionTokens: 15,
        tokensPerSecond: 35,
        promptPerSecond: 65,
      })
      expect(useAppState.getState().liveTokenStatsByThread['thread-live']).toEqual({
        promptTokens: 5,
        completionTokens: 15,
        tokensPerSecond: 35,
        promptPerSecond: 65,
      })

      s.processChunk({
        timings: { prompt_n: 5, predicted_n: 20, predicted_per_second: 40, prompt_per_second: 65 },
      })
      expect(useAppState.getState().liveTokenStatsByThread['thread-live'].completionTokens).toBe(20)

      useAppState.getState().setCurrentStreamThreadId(undefined)
      useAppState.getState().updateThreadLiveTokenStats('thread-live', undefined)
    })

    it('live promptTokens includes cache_n so context usage does not reset on cached turns', async () => {
      const { useAppState } = await import('@/hooks/useAppState')
      useAppState.getState().setCurrentStreamThreadId('thread-cached')

      const ext = await getExtractor()
      const s = ext.createStreamExtractor()
      // Deep into a conversation: only 21 tokens are freshly processed this
      // turn, the other 20,935 are served from the KV cache.
      s.processChunk({
        timings: { prompt_n: 21, cache_n: 20935, predicted_n: 95, predicted_per_second: 30 },
      })

      expect(useAppState.getState().liveTokenStatsByThread['thread-cached'].promptTokens).toBe(
        20956
      )

      useAppState.getState().setCurrentStreamThreadId(undefined)
      useAppState.getState().updateThreadLiveTokenStats('thread-cached', undefined)
    })
  })

  /* llamacpp internals */
  /**
   * A zero reply cap is never what anyone means, and only llama.cpp has a
   * spelling for "no cap". Everyone else takes `max_tokens: 0` literally and
   * returns an empty answer, so the key is left out of the request instead.
   */
  describe('a zero reply cap', () => {
    const bodySentBy = async (keepLlamacppOnly: boolean) => {
      const fetchImpl = createCustomFetch(
        vi.mocked(httpFetch) as unknown as typeof globalThis.fetch,
        { max_output_tokens: 0 },
        keepLlamacppOnly
      )
      await fetchImpl('http://x', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      })
      const call = vi.mocked(httpFetch).mock.calls.at(-1)
      return JSON.parse(call![1]!.body as string)
    }

    it("becomes llama-server's unlimited for llamacpp", async () => {
      expect((await bodySentBy(true)).max_tokens).toBe(-1)
    })

    it('is omitted for an OpenAI-compatible provider', async () => {
      const body = await bodySentBy(false)
      expect('max_tokens' in body).toBe(false)
      expect('max_output_tokens' in body).toBe(false)
    })
  })

  describe('llamacpp internals', () => {
    it('url and headers', async () => {
      vi.mocked(invoke).mockResolvedValue({ port: 8080, api_key: 'llama-key' })
      await ModelFactory.createModel('m', mkProvider('llamacpp'), {})
      const opts = getOpts()
      expect(opts.url({ path: '/chat/completions' })).toBe('http://localhost:8080/v1/chat/completions')
      expect(opts.headers().Authorization).toBe('Bearer llama-key')
      expect(opts.headers().Origin).toBe('tauri://localhost')
    })

    it('custom fetch merges params and strips client-side keys', async () => {
      vi.mocked(invoke).mockResolvedValue({ port: 8080, api_key: 'k' })
      await ModelFactory.createModel('m', mkProvider('llamacpp'), {
        temperature: 0.5,
        max_output_tokens: 1024,
        ctx_len: 4096,
        auto_compact: true,
      })
      const opts = getOpts()
      await opts.fetch('http://x', { method: 'POST', body: JSON.stringify({ messages: [] }) })
      const body = JSON.parse(vi.mocked(httpFetch).mock.calls[0][1]!.body as string)
      expect(body.temperature).toBe(0.5)
      expect(body.max_tokens).toBe(1024)
      expect(body.ctx_len).toBeUndefined()
      expect(body.auto_compact).toBeUndefined()
    })

    it("turns a zero reply cap into llama-server's unlimited", async () => {
      vi.mocked(invoke).mockResolvedValue({ port: 8080, api_key: 'k' })
      await ModelFactory.createModel('m', mkProvider('llamacpp'), {
        max_output_tokens: 0,
      })
      const opts = getOpts()
      await opts.fetch('http://x', { method: 'POST', body: JSON.stringify({ messages: [] }) })
      const body = JSON.parse(vi.mocked(httpFetch).mock.calls[0][1]!.body as string)
      expect(body.max_tokens).toBe(-1)
    })

    it('throws when startModel fails with Error', async () => {
      mockStartModel.mockRejectedValueOnce(new Error('GPU fail'))
      await expect(ModelFactory.createModel('m', mkProvider('llamacpp'), {})).rejects.toThrow('Failed to start model: GPU fail')
    })

    it('throws when startModel fails with non-Error', async () => {
      mockStartModel.mockRejectedValueOnce({ code: 'ENOMEM' })
      await expect(ModelFactory.createModel('m', mkProvider('llamacpp'), {})).rejects.toThrow('Failed to start model:')
    })

    // A serialized engine error is a plain object; it used to reach the user as
    // raw JSON including the Rust-authored English message.
    it('does not leak a serialized engine error as raw JSON', async () => {
      mockStartModel.mockRejectedValueOnce({
        code: 'MISSING_SHARED_LIBRARY',
        message: 'A library this backend depends on is missing.',
        details: 'libnccl.so.2: cannot open shared object file',
        missing_libraries: ['libnccl.so.2'],
      })

      const err = await ModelFactory.createModel('m', mkProvider('llamacpp'), {}).catch(
        (e) => e as Error
      )

      expect(err.message).not.toContain('{')
      expect(err.message).not.toContain('backend depends on')
      expect(err.message).toContain('libnccl.so.2')
    })
  })

  /* mlx internals */
  describe('mlx internals', () => {
    it('url, headers, and param merge', async () => {
      vi.mocked(invoke).mockResolvedValue({ port: 9090, api_key: 'mlx-key' })
      await ModelFactory.createModel('m', mkProvider('mlx'), { temperature: 0.3 })
      const opts = getOpts()
      expect(opts.url({ path: '/chat/completions' })).toBe('http://localhost:9090/v1/chat/completions')
      expect(opts.headers().Authorization).toBe('Bearer mlx-key')

      await opts.fetch('http://x', { method: 'POST', body: JSON.stringify({ messages: [] }) })
      const body = JSON.parse(vi.mocked(httpFetch).mock.calls[0][1]!.body as string)
      expect(body.temperature).toBe(0.3)
    })

    it('sends cancel on abort', async () => {
      vi.mocked(invoke).mockResolvedValue({ port: 9090, api_key: 'k' })
      await ModelFactory.createModel('m', mkProvider('mlx'), {})
      const opts = getOpts()
      const ctrl = new AbortController()
      await opts.fetch('http://x', { method: 'POST', body: JSON.stringify({}), signal: ctrl.signal })
      ctrl.abort()
      await new Promise((r) => setTimeout(r, 20))
      expect(vi.mocked(httpFetch)).toHaveBeenCalledTimes(2)
      expect(vi.mocked(httpFetch).mock.calls[1][0]).toBe('http://localhost:9090/v1/cancel')
      // mlx-server rejects /v1/cancel without the session key (#172).
      const cancelHeaders = vi.mocked(httpFetch).mock.calls[1][1]!.headers as Record<string, string>
      expect(cancelHeaders.Authorization).toBe('Bearer k')
    })

    it('throws when startModel fails', async () => {
      mockStartModel.mockRejectedValueOnce(new Error('No MLX'))
      await expect(ModelFactory.createModel('m', mkProvider('mlx'), {})).rejects.toThrow('Failed to start model: No MLX')
    })
  })

  /* custom headers on google, openai, xai */
  describe('custom headers', () => {
    it('google passes custom headers via the native @ai-sdk/google client', async () => {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      vi.mocked(createGoogleGenerativeAI).mockClear()
      await ModelFactory.createModel('g', mkProvider('google', { custom_header: [{ header: 'X-G', value: 'v' }] }), {})
      expect(createGoogleGenerativeAI).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-G': 'v' }),
        })
      )
    })

    it('openai passes custom headers', async () => {
      await ModelFactory.createModel('o', mkProvider('openai', { custom_header: [{ header: 'X-O', value: 'v' }] }), {})
      expect((globalThis as any).__capturedOpenAICfg.headers).toEqual({ 'X-O': 'v' })
    })

    it('xai passes custom headers', async () => {
      await ModelFactory.createModel('x', mkProvider('xai', { custom_header: [{ header: 'X-X', value: 'v' }] }), {})
      expect((globalThis as any).__capturedXaiCfg.headers).toEqual({ 'X-X': 'v' })
    })
  })

  /* google api-key rotation */
  describe('google api-key rotation', () => {
    it('rotates to the next key via x-goog-api-key on 429', async () => {
      const realFetch = globalThis.fetch
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 429 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
      try {
        await ModelFactory.createModel(
          'gemini-pro',
          mkProvider('google', { api_key: 'key1', api_key_fallbacks: ['key2'] }),
          {}
        )
        // The native @ai-sdk/google client always sends the primary key in
        // this header; the rotating fetch must OVERRIDE it, not append.
        const { fetch: rotatingFetch } = (globalThis as any).__capturedGoogleCfg
        await rotatingFetch('https://g/v1beta/models', {
          method: 'POST',
          headers: { 'x-goog-api-key': 'key1' },
          body: JSON.stringify({ messages: [] }),
        })

        expect(fetchMock).toHaveBeenCalledTimes(2)
        const firstHeaders = new Headers(fetchMock.mock.calls[0][1].headers)
        const secondHeaders = new Headers(fetchMock.mock.calls[1][1].headers)
        expect(firstHeaders.get('x-goog-api-key')).toBe('key1')
        expect(secondHeaders.get('x-goog-api-key')).toBe('key2')
        // single header, not a duplicated/appended value
        expect(secondHeaders.get('x-goog-api-key')).not.toContain('key1')
      } finally {
        globalThis.fetch = realFetch
      }
    })

    it('rotates to the next key on 402 (out of credits)', async () => {
      const realFetch = globalThis.fetch
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('{}', { status: 402 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
      try {
        await ModelFactory.createModel(
          'gemini-pro',
          mkProvider('google', { api_key: 'key1', api_key_fallbacks: ['key2'] }),
          {}
        )
        const { fetch: rotatingFetch } = (globalThis as any).__capturedGoogleCfg
        const res = await rotatingFetch('https://g/v1beta/models', {
          method: 'POST',
          headers: { 'x-goog-api-key': 'key1' },
          body: '{}',
        })
        expect(res.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(
          new Headers(fetchMock.mock.calls[1][1].headers).get('x-goog-api-key')
        ).toBe('key2')
      } finally {
        globalThis.fetch = realFetch
      }
    })

    it('uses a plain custom fetch (no rotation) with a single key', async () => {
      await ModelFactory.createModel(
        'gemini-pro',
        mkProvider('google', { api_key: 'only', api_key_fallbacks: [] }),
        {}
      )
      const { apiKey } = (globalThis as any).__capturedGoogleCfg
      expect(apiKey).toBe('only')
    })
  })

  /* openai-compatible empty base_url */
  describe('openai-compatible', () => {
    it('uses default base_url when none provided', async () => {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
      await ModelFactory.createModel('m', mkProvider('custom', { base_url: undefined }), {})
      expect(vi.mocked(createOpenAICompatible)).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://api.openai.com/v1' })
      )
    })
  })
})
