import { describe, it, expect } from 'vitest'
import type { LanguageModelUsage } from 'ai'
import {
  combineTokenUsage,
  createUsageCollector,
  describeTokenUsage,
  finalizeTokenUsage,
  fromCoworkUsage,
  normalizeLanguageModelUsage,
  readTokenUsage,
  toCoworkUsage,
  usageValueKinds,
} from '@/lib/tokenUsage'

/**
 * What the AI SDK hands over: its own normalized numbers (with absent cache
 * counts already defaulted to zero by the provider converters) plus `raw`,
 * the provider's usage object as it arrived.
 */
const sdkUsage = (
  over: Partial<LanguageModelUsage> & { raw?: Record<string, unknown> }
): LanguageModelUsage =>
  ({
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
    ...over,
  }) as LanguageModelUsage

describe('normalizeLanguageModelUsage', () => {
  it('reads OpenAI prompt_tokens_details.cached_tokens', () => {
    const usage = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 2006,
        outputTokens: 300,
        totalTokens: 2306,
        inputTokenDetails: {
          noCacheTokens: 86,
          cacheReadTokens: 1920,
          cacheWriteTokens: undefined,
        },
        raw: {
          prompt_tokens: 2006,
          completion_tokens: 300,
          total_tokens: 2306,
          prompt_tokens_details: { cached_tokens: 1920 },
        },
      })
    )
    expect(usage).toEqual({
      inputTokens: 2006,
      outputTokens: 300,
      totalTokens: 2306,
      cachedInputTokens: 1920,
      uncachedInputTokens: 86,
      cacheSource: 'openai-chat',
    })
  })

  it('reads Anthropic cache read and creation, without adding creation twice', () => {
    // The Anthropic converter's input total is input + read + creation.
    const usage = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 12 + 2000 + 300,
        outputTokens: 6,
        totalTokens: 2318,
        inputTokenDetails: {
          noCacheTokens: 12,
          cacheReadTokens: 2000,
          cacheWriteTokens: 300,
        },
        raw: {
          input_tokens: 12,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 300,
          output_tokens: 1,
        },
      })
    )
    expect(usage.inputTokens).toBe(2312)
    expect(usage.cachedInputTokens).toBe(2000)
    // Fresh input plus what was written: both were processed this request.
    expect(usage.uncachedInputTokens).toBe(312)
    expect(usage.cacheWriteTokens).toBe(300)
    expect(usage.totalTokens).toBe(2318)
    expect(usage.cacheSource).toBe('anthropic')
  })

  it('reads llama.cpp usage, including a measured zero on a cold cache', () => {
    // Captured from llama-server (v100:8080): first turn, nothing cached yet.
    const cold = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 5974,
        outputTokens: 8,
        totalTokens: 5982,
        raw: {
          completion_tokens: 8,
          prompt_tokens: 5974,
          total_tokens: 5982,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      })
    )
    expect(cold.cachedInputTokens).toBe(0)
    expect(cold.uncachedInputTokens).toBe(5974)

    // Follow-up on the same prefix.
    const warm = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 5974,
        outputTokens: 8,
        totalTokens: 5982,
        raw: {
          completion_tokens: 8,
          prompt_tokens: 5974,
          total_tokens: 5982,
          prompt_tokens_details: { cached_tokens: 5957 },
        },
      })
    )
    expect(warm.cachedInputTokens).toBe(5957)
    expect(warm.uncachedInputTokens).toBe(17)
  })

  it('falls back to the engine timings (cache_n) when usage carried no cache count', () => {
    const usage = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 5974,
        outputTokens: 8,
        raw: { prompt_tokens: 5974, completion_tokens: 8 },
      }),
      { providerMetadata: { promptTokens: 5974, completionTokens: 8, cacheTokens: 5957 } }
    )
    expect(usage.cachedInputTokens).toBe(5957)
    expect(usage.cacheSource).toBe('engine-timings')
  })

  it('takes counts from the engine timings when a local server sent no usage at all', () => {
    const usage = normalizeLanguageModelUsage(sdkUsage({}), {
      providerMetadata: { promptTokens: 221, completionTokens: 95, cacheTokens: 200 },
    })
    expect(usage).toMatchObject({
      inputTokens: 221,
      outputTokens: 95,
      totalTokens: 316,
      cachedInputTokens: 200,
      uncachedInputTokens: 21,
    })
  })

  it('leaves cache fields absent when the provider reported none, despite the SDK defaulting them to 0', () => {
    // vLLM without prompt-token details: the SDK's converter still says 0.
    const usage = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 6100,
        outputTokens: 3,
        totalTokens: 6103,
        inputTokenDetails: {
          noCacheTokens: 6100,
          cacheReadTokens: 0,
          cacheWriteTokens: undefined,
        },
        raw: { prompt_tokens: 6100, total_tokens: 6103, completion_tokens: 3 },
      })
    )
    expect(usage).toEqual({ inputTokens: 6100, outputTokens: 3, totalTokens: 6103 })
    expect('cachedInputTokens' in usage).toBe(false)
    expect('uncachedInputTokens' in usage).toBe(false)
  })

  it('treats an Anthropic-shaped response with no cache keys as unreported', () => {
    const usage = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 6100,
        outputTokens: 2,
        inputTokenDetails: { noCacheTokens: 6100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        raw: { input_tokens: 6100, output_tokens: 0 },
      })
    )
    expect(usage.cachedInputTokens).toBeUndefined()
    expect(usage.cacheWriteTokens).toBeUndefined()
  })

  it('reads OpenAI Responses and Gemini cache counts', () => {
    const responses = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 100,
        outputTokens: 5,
        raw: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 64 } },
      })
    )
    expect(responses).toMatchObject({ cachedInputTokens: 64, cacheSource: 'openai-responses' })

    const gemini = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 900,
        outputTokens: 10,
        raw: { promptTokenCount: 900, candidatesTokenCount: 10, cachedContentTokenCount: 800 },
      })
    )
    expect(gemini).toMatchObject({ cachedInputTokens: 800, uncachedInputTokens: 100, cacheSource: 'google' })

    const geminiCold = normalizeLanguageModelUsage(
      sdkUsage({ inputTokens: 900, outputTokens: 10, raw: { promptTokenCount: 900 } })
    )
    expect(geminiCold.cachedInputTokens).toBeUndefined()
  })

  it('clamps a cached count larger than the input and keeps the reported value', () => {
    const usage = normalizeLanguageModelUsage(
      sdkUsage({
        inputTokens: 100,
        outputTokens: 1,
        raw: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 250 } },
      })
    )
    expect(usage.cachedInputTokens).toBe(100)
    expect(usage.uncachedInputTokens).toBe(0)
    expect(usage.reported).toEqual({ cachedInputTokens: 250 })
  })

  it('clamps a cache write larger than the uncached input', () => {
    const usage = finalizeTokenUsage({
      inputTokens: 100,
      cachedInputTokens: 90,
      cacheWriteTokens: 40,
    })
    expect(usage.uncachedInputTokens).toBe(10)
    expect(usage.cacheWriteTokens).toBe(10)
    expect(usage.reported).toEqual({ cacheWriteTokens: 40 })
  })

  it('ignores negative and non-numeric counts rather than zeroing them', () => {
    const usage = finalizeTokenUsage({
      inputTokens: 10,
      cachedInputTokens: -3,
      cacheWriteTokens: 'x',
    })
    expect(usage.cachedInputTokens).toBeUndefined()
    expect(usage.cacheWriteTokens).toBeUndefined()
  })
})

describe('combineTokenUsage', () => {
  it('adds two separate calls and keeps cache counts only when both reported', () => {
    const both = combineTokenUsage(
      finalizeTokenUsage({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 60 }),
      finalizeTokenUsage({ inputTokens: 200, outputTokens: 7, cachedInputTokens: 150 })
    )
    expect(both).toMatchObject({
      inputTokens: 300,
      outputTokens: 12,
      cachedInputTokens: 210,
      uncachedInputTokens: 90,
    })

    const partial = combineTokenUsage(
      finalizeTokenUsage({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 60 }),
      finalizeTokenUsage({ inputTokens: 200, outputTokens: 7 })
    )
    expect(partial.inputTokens).toBe(300)
    expect(partial.cachedInputTokens).toBeUndefined()
  })
})

describe('createUsageCollector', () => {
  it('uses the per-step usage with raw, not the summed finish total', () => {
    const collector = createUsageCollector()
    collector.observe({
      type: 'finish-step',
      usage: sdkUsage({
        inputTokens: 5974,
        outputTokens: 8,
        raw: { prompt_tokens: 5974, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 5957 } },
      }),
    })
    // The SDK's total has lost `raw`; its cacheRead would look authoritative.
    const total = collector.total(
      sdkUsage({
        inputTokens: 5974,
        outputTokens: 8,
        inputTokenDetails: { noCacheTokens: 17, cacheReadTokens: 5957, cacheWriteTokens: undefined },
      })
    )
    expect(total.cachedInputTokens).toBe(5957)
    expect(total.uncachedInputTokens).toBe(17)
  })

  it('does not trust the summed total for cache counts when no step was seen', () => {
    const total = createUsageCollector().total(
      sdkUsage({
        inputTokens: 10,
        outputTokens: 2,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: undefined },
      })
    )
    expect(total).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
  })
})

describe('persistence shapes', () => {
  it('reads a message saved before cache accounting as "not reported"', () => {
    const legacy = readTokenUsage({ inputTokens: 120, outputTokens: 30, totalTokens: 150 })
    expect(legacy).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 })
    expect(legacy?.cachedInputTokens).toBeUndefined()
  })

  it('re-derives the uncached count on read instead of trusting a stored one', () => {
    const back = readTokenUsage({
      inputTokens: 100,
      cachedInputTokens: 60,
      uncachedInputTokens: 999,
      totalTokens: 110,
    })
    expect(back?.uncachedInputTokens).toBe(40)
  })

  it('survives a JSON round trip unchanged', () => {
    const original = finalizeTokenUsage({
      inputTokens: 2312,
      outputTokens: 6,
      cachedInputTokens: 2000,
      cacheWriteTokens: 300,
      cacheSource: 'anthropic',
    })
    expect(readTokenUsage(JSON.parse(JSON.stringify(original)))).toEqual(original)
  })

  it('maps to and from the Cowork snake_case form without losing or inventing fields', () => {
    const usage = finalizeTokenUsage({
      inputTokens: 5974,
      outputTokens: 8,
      cachedInputTokens: 5957,
      cacheSource: 'openai-chat',
    })
    const cowork = toCoworkUsage(usage)
    expect(cowork).toEqual({
      prompt_tokens: 5974,
      completion_tokens: 8,
      total_tokens: 5982,
      cached_prompt_tokens: 5957,
      uncached_prompt_tokens: 17,
      cache_source: 'openai-chat',
    })
    expect(fromCoworkUsage(JSON.parse(JSON.stringify(cowork)))).toEqual(usage)

    const legacy = fromCoworkUsage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })
    expect(legacy).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    expect('cached_prompt_tokens' in toCoworkUsage(legacy!)).toBe(false)
  })

  it('describes an unreported cache as unreported', () => {
    expect(describeTokenUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })).toContain(
      'cache not reported'
    )
  })
})

describe('usageValueKinds', () => {
  it('says which values were reported, derived or clamped, and none are estimated', () => {
    const kinds = usageValueKinds(
      finalizeTokenUsage({
        inputTokens: 100,
        outputTokens: 1,
        cachedInputTokens: 250,
        cacheWriteTokens: 0,
      })
    )
    expect(kinds).toEqual({
      input: 'reported',
      output: 'reported',
      total: 'derived',
      cached: 'clamped',
      uncached: 'derived',
      cacheWrite: 'reported',
    })
    expect(Object.values(kinds)).not.toContain('estimated')
  })

  it('gives an unavailable value no kind at all', () => {
    expect(usageValueKinds({ inputTokens: 10 })).toEqual({ input: 'reported' })
  })
})
