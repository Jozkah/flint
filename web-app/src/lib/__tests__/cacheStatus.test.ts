import { describe, it, expect } from 'vitest'
import type { LanguageModelUsage } from 'ai'
import {
  cacheReusePercent,
  cacheStatus,
  combineTokenUsage,
  exactUsageText,
  finalizeTokenUsage,
  fromCoworkUsage,
  normalizeLanguageModelUsage,
  readTokenUsage,
  summarizeUsage,
  toCoworkUsage,
  type TokenUsage,
} from '@/lib/tokenUsage'

const sdk = (raw: Record<string, unknown>, over: Partial<LanguageModelUsage> = {}) =>
  ({
    inputTokens: (raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokenCount) as number,
    outputTokens: (raw.completion_tokens ?? raw.output_tokens ?? raw.candidatesTokenCount) as number,
    totalTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    raw,
    ...over,
  }) as LanguageModelUsage

const openai = (prompt: number, cached?: number | null, completion = 5) =>
  normalizeLanguageModelUsage(
    sdk({
      prompt_tokens: prompt,
      completion_tokens: completion,
      ...(cached === undefined
        ? {}
        : { prompt_tokens_details: cached === null ? null : { cached_tokens: cached } }),
    })
  )

describe('cache status, from provider-reported counts only', () => {
  it('cached > 0 is reuse, with both cached and uncached shown', () => {
    const u = openai(1000, 900)
    expect(cacheStatus(u)).toBe('reused')
    expect(u.uncachedInputTokens).toBe(100)
    expect(cacheReusePercent(u)).toBeCloseTo(90)
  })

  it('an explicit zero is "no cached input", not unknown', () => {
    const u = openai(1000, 0)
    expect(cacheStatus(u)).toBe('none')
    expect(u.cachedInputTokens).toBe(0)
    expect(u.uncachedInputTokens).toBe(1000)
    expect(cacheReusePercent(u)).toBe(0)
  })

  it('an absent field, or details: null, is "not reported" and never a miss', () => {
    for (const u of [openai(1776, undefined), openai(1776, null)]) {
      expect(cacheStatus(u)).toBe('not-reported')
      expect(u.cachedInputTokens).toBeUndefined()
      expect(u.uncachedInputTokens).toBeUndefined()
      expect(cacheReusePercent(u)).toBeUndefined()
    }
    expect(cacheStatus(undefined)).toBe('not-reported')
  })

  it('cached equal to input is full reuse, uncached zero', () => {
    const u = openai(512, 512)
    expect(cacheStatus(u)).toBe('reused')
    expect(u.uncachedInputTokens).toBe(0)
    expect(cacheReusePercent(u)).toBe(100)
  })

  it('a partly cached prompt is still reuse', () => {
    const u = openai(6379, 6342)
    expect(cacheStatus(u)).toBe('reused')
    expect(u.uncachedInputTokens).toBe(37)
  })

  it('a cached count larger than the input is clamped, still reuse, raw kept', () => {
    const u = openai(100, 250)
    expect(cacheStatus(u)).toBe('reused')
    expect(u.cachedInputTokens).toBe(100)
    expect(u.uncachedInputTokens).toBe(0)
    expect(u.reported).toEqual({ cachedInputTokens: 250 })
    expect(cacheReusePercent(u)).toBe(100)
  })

  it('reads every raw field shape a provider uses', () => {
    const responses = normalizeLanguageModelUsage(
      sdk({ input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 64 } })
    )
    expect([responses.cachedInputTokens, responses.cacheSource]).toEqual([64, 'openai-responses'])
    const anthropic = normalizeLanguageModelUsage(
      sdk(
        { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 },
        {
          inputTokens: 100,
          inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 },
        }
      )
    )
    expect(cacheStatus(anthropic)).toBe('reused')
    // Reads and writes stay apart; a write is never counted as a read.
    expect([anthropic.cachedInputTokens, anthropic.cacheWriteTokens]).toEqual([80, 10])
    const writeOnly = normalizeLanguageModelUsage(
      sdk(
        { input_tokens: 90, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 90 },
        {
          inputTokens: 90,
          inputTokenDetails: { noCacheTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 90 },
        }
      )
    )
    expect(cacheStatus(writeOnly)).toBe('none')
    const google = normalizeLanguageModelUsage(
      sdk({ promptTokenCount: 300, candidatesTokenCount: 2, cachedContentTokenCount: 200 })
    )
    expect([google.cachedInputTokens, google.cacheSource]).toEqual([200, 'google'])
    const engine = normalizeLanguageModelUsage(
      sdk({ prompt_tokens: 500, completion_tokens: 3 }),
      { providerMetadata: { promptTokens: 500, completionTokens: 3, cacheTokens: 480 } }
    )
    expect([cacheStatus(engine), engine.cacheSource]).toEqual(['reused', 'engine-timings'])
  })

  it('exact values name what was not reported', () => {
    expect(exactUsageText(openai(1776, undefined, 2))).toBe(
      'Input 1,776, Cached not reported, Uncached not reported, Output 2, Total 1,778'
    )
    expect(exactUsageText(openai(1000, 900, 5))).toBe(
      'Input 1,000, Cached 900, Uncached 100, Output 5, Total 1,005'
    )
  })
})

describe('several requests: a turn or a session', () => {
  it('keeps a hit when another request did not report the cache', () => {
    const turn = combineTokenUsage(openai(1000, 900), openai(1100, undefined))
    // No cached total can be claimed for both...
    expect(turn.cachedInputTokens).toBeUndefined()
    // ...but one request did read from the cache, and the flag says so.
    expect(cacheStatus(turn)).toBe('reused')
    expect([turn.requests, turn.cacheReportedRequests, turn.cacheHitRequests]).toEqual([2, 1, 1])
  })

  it('counts requests apart from tokens', () => {
    const session = summarizeUsage([openai(1000, 900), openai(1000, 0), openai(1000, 800)])!
    expect(session.cachedInputTokens).toBe(1700)
    expect(session.inputTokens).toBe(3000)
    expect([session.requests, session.cacheHitRequests]).toEqual([3, 2])
    expect(cacheStatus(session)).toBe('reused')
  })

  it('two requests that reuse a provider call id are still two requests', () => {
    // A local server numbers tool calls from zero in every response; usage is
    // per request, never keyed by call id, so both are counted.
    const a = openai(1000, 900)
    const b = openai(1000, 900)
    expect(combineTokenUsage(a, b).requests).toBe(2)
  })

  it('all zero is no cached input; all unreported is not reported', () => {
    expect(cacheStatus(summarizeUsage([openai(10, 0), openai(10, 0)]))).toBe('none')
    expect(cacheStatus(summarizeUsage([openai(10), openai(10)]))).toBe('not-reported')
    expect(summarizeUsage([])).toBeUndefined()
  })

  it('one session never absorbs another session\'s usage', () => {
    const bySession: Record<string, TokenUsage[]> = {
      a: [openai(1000, 900)],
      b: [openai(2000, undefined)],
    }
    // Rapid switching reads each session's own list; nothing is shared.
    for (let i = 0; i < 20; i++) {
      const id = i % 2 ? 'a' : 'b'
      const s = summarizeUsage(bySession[id])
      expect(cacheStatus(s)).toBe(id === 'a' ? 'reused' : 'not-reported')
      expect(s?.inputTokens).toBe(id === 'a' ? 1000 : 2000)
    }
  })
})

describe('persistence, restart and export/import', () => {
  it('survives the Cowork store and a JSON round trip with its status', () => {
    for (const u of [openai(1000, 900), openai(1000, 0), openai(1000)]) {
      const back = fromCoworkUsage(JSON.parse(JSON.stringify(toCoworkUsage(u))))
      expect(back).toEqual(u)
      expect(cacheStatus(back)).toBe(cacheStatus(u))
    }
  })

  it('normalizes imported usage: malformed counts clamped, strings dropped', () => {
    const imported = readTokenUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      cached_prompt_tokens: 400,
      uncached_prompt_tokens: 77,
      cache_hit_requests: 'many',
    })!
    expect(imported.cachedInputTokens).toBe(100)
    expect(imported.uncachedInputTokens).toBe(0)
    expect(imported.cacheHitRequests).toBeUndefined()
    expect(cacheStatus(imported)).toBe('reused')
  })

  it('a usage saved before cache accounting reads as not reported', () => {
    const legacy = readTokenUsage({ inputTokens: 120, outputTokens: 30 })
    expect(cacheStatus(legacy)).toBe('not-reported')
    expect(finalizeTokenUsage({}).requests).toBeUndefined()
  })
})
