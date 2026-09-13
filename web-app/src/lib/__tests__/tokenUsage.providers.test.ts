/**
 * Provider usage through the real AI SDK providers, end to end to the message
 * metadata the transport stores.
 *
 * Each case drives an actual provider model (`@ai-sdk/openai-compatible`, the
 * llama.cpp model Jan builds, `@ai-sdk/anthropic`) over a fetch that replays a
 * wire response, then folds the stream exactly as the Chat transport and the
 * Cowork subagent do. The llama.cpp and vLLM bodies are captured verbatim from
 * real servers; the Anthropic body follows the documented Messages streaming
 * shape. This proves the parsing, not the provider: the live check against a
 * real server is the cowork-smoke `token-usage-cache` scenario.
 */
import { describe, it, expect, vi } from 'vitest'
import { streamText } from 'ai'
import {
  createOpenAICompatible,
  OpenAICompatibleChatLanguageModel,
} from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createUsageCollector, type TokenUsage } from '@/lib/tokenUsage'

vi.mock('@/hooks/useAppState', () => {
  const state = {
    currentStreamThreadId: undefined,
    loadingModel: false,
    updateLoadingModel: vi.fn(),
    updateThreadLoadingModel: vi.fn(),
    updateLiveTokenStats: vi.fn(),
    updateThreadLiveTokenStats: vi.fn(),
    updatePromptProgress: vi.fn(),
    updateThreadPromptProgress: vi.fn(),
  }
  return { useAppState: { getState: () => state } }
})

const sse = (events: Array<unknown>, named = false): Response => {
  const body = events
    .map((e) => {
      if (e === '[DONE]') return 'data: [DONE]\n\n'
      const { event, ...data } = e as { event?: string }
      return named && event
        ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        : `data: ${JSON.stringify(e)}\n\n`
    })
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const replay = (response: () => Response) =>
  vi.fn(async () => response()) as unknown as typeof fetch

/** Fold a stream the way the transport's `messageMetadata` does. */
async function finalUsage(
  model: Parameters<typeof streamText>[0]['model']
): Promise<TokenUsage | undefined> {
  const result = streamText({ model, prompt: 'Say hi.' })
  const collector = createUsageCollector()
  let usage: TokenUsage | undefined
  const stream = result.toUIMessageStream({
    messageMetadata: ({ part }) => {
      collector.observe(part)
      if (part.type !== 'finish') return undefined
      usage = collector.total(
        (part as unknown as { totalUsage: Parameters<typeof collector.total>[0] })
          .totalUsage
      )
      return { usage }
    },
  })
  let fromMetadata: TokenUsage | undefined
  for await (const chunk of stream as unknown as AsyncIterable<{
    type: string
    messageMetadata?: { usage?: TokenUsage }
  }>) {
    if (chunk.type === 'finish' && chunk.messageMetadata?.usage) {
      fromMetadata = chunk.messageMetadata.usage
    }
  }
  // What the transport attaches is what gets persisted.
  expect(fromMetadata).toEqual(usage)
  return fromMetadata
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
})

const finishChunk = (extra: Record<string, unknown> = {}) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  ...extra,
})

describe('provider usage through the AI SDK', () => {
  it('OpenAI-compatible: reads prompt_tokens_details.cached_tokens', async () => {
    const provider = createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: 'http://provider.test/v1',
      includeUsage: true,
      fetch: replay(() =>
        sse([
          chunk({ role: 'assistant', content: 'Hi' }),
          finishChunk(),
          {
            ...finishChunk(),
            choices: [],
            usage: {
              prompt_tokens: 2006,
              completion_tokens: 300,
              total_tokens: 2306,
              prompt_tokens_details: { cached_tokens: 1920 },
            },
          },
          '[DONE]',
        ])
      ),
    })
    const usage = await finalUsage(provider.languageModel('gpt'))
    expect(usage).toEqual({
      inputTokens: 2006,
      outputTokens: 300,
      totalTokens: 2306,
      cachedInputTokens: 1920,
      uncachedInputTokens: 86,
      cacheSource: 'openai-chat',
      requests: 1,
      cacheReportedRequests: 1,
      cacheHitRequests: 1,
    })
  })

  it('llama.cpp: a follow-up that reused the prefix (captured from llama-server)', async () => {
    // Verbatim tail of a real llama-server stream on the second turn of a
    // conversation: timings arrive per chunk (cumulative), usage once at the end.
    const model = new OpenAICompatibleChatLanguageModel('qwen3.8-27b', {
      provider: 'llamacpp',
      headers: () => ({}),
      url: ({ path }) => `http://localhost:1/v1${path}`,
      includeUsage: true,
      fetch: replay(() =>
        sse([
          chunk(
            { role: 'assistant', content: 'Hi' },
            { timings: { cache_n: 5957, prompt_n: 17, predicted_n: 1 } }
          ),
          chunk(
            { content: '!' },
            { timings: { cache_n: 5957, prompt_n: 17, predicted_n: 8 } }
          ),
          finishChunk({ timings: { cache_n: 5957, prompt_n: 17, predicted_n: 8 } }),
          {
            ...finishChunk(),
            choices: [],
            usage: {
              completion_tokens: 8,
              prompt_tokens: 5974,
              total_tokens: 5982,
              prompt_tokens_details: { cached_tokens: 5957 },
            },
            timings: {
              cache_n: 5957,
              prompt_n: 17,
              prompt_ms: 531.232,
              predicted_n: 8,
              predicted_per_second: 51.79,
            },
          },
          '[DONE]',
        ])
      ),
    })
    const usage = await finalUsage(model)
    // Cumulative snapshots: the last one wins, nothing is summed.
    expect(usage).toEqual({
      inputTokens: 5974,
      outputTokens: 8,
      totalTokens: 5982,
      cachedInputTokens: 5957,
      uncachedInputTokens: 17,
      cacheSource: 'openai-chat',
      requests: 1,
      cacheReportedRequests: 1,
      cacheHitRequests: 1,
    })
  })

  it('llama.cpp: falls back to the engine metadata extractor (cache_n) when usage has no details', async () => {
    // Built the way Jan builds it, with Jan's own timings extractor.
    const { __llamacppExtractorForTests } = await import('@/lib/model-factory')
    const model = new OpenAICompatibleChatLanguageModel('m', {
      provider: 'llamacpp',
      headers: () => ({}),
      url: ({ path }) => `http://localhost:1/v1${path}`,
      includeUsage: true,
      metadataExtractor: __llamacppExtractorForTests,
      fetch: replay(() =>
        sse([
          chunk({ role: 'assistant', content: 'Hi' }, { timings: { cache_n: 200, prompt_n: 21, predicted_n: 1 } }),
          finishChunk({ timings: { cache_n: 200, prompt_n: 21, predicted_n: 95 } }),
          {
            ...finishChunk(),
            choices: [],
            usage: { completion_tokens: 95, prompt_tokens: 221, total_tokens: 316 },
          },
          '[DONE]',
        ])
      ),
    })
    const usage = await finalUsage(model)
    expect(usage).toMatchObject({
      inputTokens: 221,
      cachedInputTokens: 200,
      uncachedInputTokens: 21,
      cacheSource: 'engine-timings',
    })
  })

  it('vLLM without prompt-token details: no cache fields at all (captured)', async () => {
    const provider = createOpenAICompatible({
      name: 'vllm',
      baseURL: 'http://provider.test/v1',
      includeUsage: true,
      fetch: replay(() =>
        sse([
          chunk({ role: 'assistant', content: 'Hi' }),
          finishChunk(),
          {
            ...finishChunk(),
            choices: [],
            usage: { prompt_tokens: 6100, total_tokens: 6103, completion_tokens: 3 },
          },
          '[DONE]',
        ])
      ),
    })
    const usage = await finalUsage(provider.languageModel('pxa-27b'))
    expect(usage).toEqual({ inputTokens: 6100, outputTokens: 3, totalTokens: 6103, requests: 1, cacheReportedRequests: 0, cacheHitRequests: 0 })
  })

  it('vLLM with prompt-token details: the cache count arrives only in the final usage chunk', async () => {
    const provider = createOpenAICompatible({
      name: 'vllm',
      baseURL: 'http://provider.test/v1',
      includeUsage: true,
      fetch: replay(() =>
        sse([
          chunk({ role: 'assistant', content: 'O' }),
          chunk({ content: 'K' }),
          finishChunk(),
          {
            ...finishChunk(),
            choices: [],
            usage: {
              prompt_tokens: 1776,
              total_tokens: 1778,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 1760 },
            },
          },
          '[DONE]',
        ])
      ),
    })
    const usage = await finalUsage(provider.languageModel('pxa-27b'))
    expect(usage).toMatchObject({
      inputTokens: 1776,
      cachedInputTokens: 1760,
      uncachedInputTokens: 16,
      cacheHitRequests: 1,
    })
  })

  it('malformed: a cached count larger than the input is clamped, the raw value kept', async () => {
    const provider = createOpenAICompatible({
      name: 'broken',
      baseURL: 'http://provider.test/v1',
      includeUsage: true,
      fetch: replay(() =>
        sse([
          chunk({ role: 'assistant', content: 'Hi' }),
          finishChunk(),
          {
            ...finishChunk(),
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 1,
              total_tokens: 101,
              prompt_tokens_details: { cached_tokens: 250 },
            },
          },
          '[DONE]',
        ])
      ),
    })
    const usage = await finalUsage(provider.languageModel('m'))
    expect(usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 100,
      uncachedInputTokens: 0,
      reported: { cachedInputTokens: 250 },
    })
  })

  it('cumulative usage sent on several chunks keeps the final values, not their sum', async () => {
    const provider = createOpenAICompatible({
      name: 'cumulative',
      baseURL: 'http://provider.test/v1',
      includeUsage: true,
      fetch: replay(() =>
        sse([
          chunk(
            { role: 'assistant', content: 'a' },
            { usage: { prompt_tokens: 500, completion_tokens: 1, total_tokens: 501, prompt_tokens_details: { cached_tokens: 400 } } }
          ),
          chunk(
            { content: 'b' },
            { usage: { prompt_tokens: 500, completion_tokens: 2, total_tokens: 502, prompt_tokens_details: { cached_tokens: 400 } } }
          ),
          finishChunk({
            usage: { prompt_tokens: 500, completion_tokens: 3, total_tokens: 503, prompt_tokens_details: { cached_tokens: 400 } },
          }),
          '[DONE]',
        ])
      ),
    })
    const usage = await finalUsage(provider.languageModel('m'))
    expect(usage).toMatchObject({
      inputTokens: 500,
      outputTokens: 3,
      cachedInputTokens: 400,
      uncachedInputTokens: 100,
      totalTokens: 503,
    })
  })

  it('Anthropic: cache read and creation, updated by message_delta', async () => {
    const anthropic = createAnthropic({
      apiKey: 'test',
      baseURL: 'http://provider.test/v1',
      fetch: replay(() =>
        sse(
          [
            {
              event: 'message_start',
              type: 'message_start',
              message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-5',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 12,
                  cache_creation_input_tokens: 300,
                  cache_read_input_tokens: 2000,
                  output_tokens: 1,
                },
              },
            },
            {
              event: 'content_block_start',
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
            {
              event: 'content_block_delta',
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hi' },
            },
            { event: 'content_block_stop', type: 'content_block_stop', index: 0 },
            {
              event: 'message_delta',
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: {
                output_tokens: 6,
                cache_creation_input_tokens: 300,
                cache_read_input_tokens: 2000,
              },
            },
            { event: 'message_stop', type: 'message_stop' },
          ],
          true
        )
      ),
    })
    const usage = await finalUsage(anthropic('claude-sonnet-4-5'))
    expect(usage).toEqual({
      inputTokens: 2312,
      outputTokens: 6,
      totalTokens: 2318,
      cachedInputTokens: 2000,
      uncachedInputTokens: 312,
      cacheWriteTokens: 300,
      cacheSource: 'anthropic',
      requests: 1,
      cacheReportedRequests: 1,
      cacheHitRequests: 1,
    })
  })

  it('Anthropic-compatible server that sends no cache fields: not reported (captured from vLLM)', async () => {
    const anthropic = createAnthropic({
      apiKey: 'test',
      baseURL: 'http://provider.test/v1',
      fetch: replay(() =>
        sse(
          [
            {
              event: 'message_start',
              type: 'message_start',
              message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'pxa-27b',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 6100, output_tokens: 0 },
              },
            },
            {
              event: 'content_block_start',
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
            {
              event: 'content_block_delta',
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hi' },
            },
            { event: 'content_block_stop', type: 'content_block_stop', index: 0 },
            {
              event: 'message_delta',
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { input_tokens: 6100, output_tokens: 2 },
            },
            { event: 'message_stop', type: 'message_stop' },
          ],
          true
        )
      ),
    })
    const usage = await finalUsage(anthropic('pxa-27b'))
    expect(usage).toEqual({ inputTokens: 6100, outputTokens: 2, totalTokens: 6102, requests: 1, cacheReportedRequests: 0, cacheHitRequests: 0 })
  })
})
