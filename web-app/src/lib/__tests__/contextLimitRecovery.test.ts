/**
 * Learning a context window from the server that refused a request for
 * exceeding it.
 *
 * The failure mode this guards against is not "we missed a limit" -- it is
 * "we invented one". A number scraped out of an unrelated sentence becomes a
 * window that is then enforced silently on every later request, which is worse
 * than the unknown window it replaced.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  bindingKey,
  forgetAllServerLimits,
  forgetServerLimit,
  parseServerContextLimit,
  planRecovery,
  rememberServerLimit,
  serverReportedLimit,
  type EndpointBinding,
} from '../contextLimitRecovery'

const local: EndpointBinding = {
  provider: 'llamacpp',
  baseUrl: 'http://llm-host:8080/v1',
  model: 'qwen3-8b',
}

beforeEach(() => forgetAllServerLimits())

describe('reading a limit out of a refusal', () => {
  it('prefers a structured field over anything in the prose', () => {
    const limit = parseServerContextLimit({
      error: {
        message: 'the request exceeds the available context size',
        n_ctx: 8192,
        n_prompt_tokens: 9001,
      },
    })
    expect(limit).toEqual({
      contextTokens: 8192,
      requestTokens: 9001,
      via: 'structured-field',
    })
  })

  it.each([
    ['n_ctx', 4096],
    ['context_length', 4096],
    ['max_context_length', 4096],
    ['max_model_len', 4096],
    ['context_size', 4096],
  ])('reads %s', (field, value) => {
    const limit = parseServerContextLimit({ error: { [field]: value } })
    expect(limit?.contextTokens).toBe(4096)
    expect(limit?.via).toBe('structured-field')
  })

  it('finds a field nested where OpenAI-compatible servers put it', () => {
    expect(
      parseServerContextLimit({ error: { metadata: { n_ctx: 2048 } } })
        ?.contextTokens
    ).toBe(2048)
  })

  /// Reading `max_tokens` off an error would shrink the model permanently: on
  /// an error it is the reply cap that was rejected, not the window.
  it('never reads a reply cap as the window', () => {
    expect(
      parseServerContextLimit({ error: { max_tokens: 512, message: 'nope' } })
    ).toBeNull()
  })

  it.each([
    [
      'llama.cpp request form',
      'the request exceeds the available context size. request (9001 tokens) exceeds the available context size (8192 tokens)',
      8192,
      9001,
    ],
    [
      'llama.cpp input form',
      'input (5000 tokens) is larger than the max context size (4096 tokens)',
      4096,
      5000,
    ],
    [
      'OpenAI-compatible form',
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.",
      8192,
      9001,
    ],
    [
      'vLLM form',
      "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens",
      4096,
      5000,
    ],
  ])('reads the %s', (_label, message, tokens, request) => {
    const limit = parseServerContextLimit(null, message)
    expect(limit).toEqual({
      contextTokens: tokens,
      requestTokens: request,
      via: 'known-message',
    })
  })

  /// The rule that keeps this from inventing windows.
  it('refuses to scrape numbers out of an unrelated message', () => {
    for (const message of [
      'Rate limit reached: 3500 requests per minute, 90000 tokens per minute',
      'Billing: you have used 120000 of 500000 tokens this month',
      'HTTP 429 after 3 attempts over 60 seconds',
      'Internal error 5001 while loading model 7000',
      '',
    ]) {
      expect(parseServerContextLimit(null, message)).toBeNull()
    }
  })

  /// A limit that is not smaller than the request cannot be what refused it,
  /// so the two numbers are not what they look like.
  it('refuses a pair whose numbers contradict the refusal', () => {
    expect(
      parseServerContextLimit(
        null,
        'request (100 tokens) exceeds the available context size (8192 tokens)'
      )
    ).toBeNull()
  })

  it('refuses implausible windows in either direction', () => {
    expect(parseServerContextLimit({ error: { n_ctx: 12 } })).toBeNull()
    expect(parseServerContextLimit({ error: { n_ctx: 0 } })).toBeNull()
    expect(parseServerContextLimit({ error: { n_ctx: -4096 } })).toBeNull()
    expect(
      parseServerContextLimit({ error: { n_ctx: 999_999_999_999 } })
    ).toBeNull()
  })

  it('accepts a numeric string, which is how plenty of servers send it', () => {
    expect(
      parseServerContextLimit({ error: { n_ctx: '8192' } })?.contextTokens
    ).toBe(8192)
  })

  it('says nothing when the payload says nothing', () => {
    expect(parseServerContextLimit(null)).toBeNull()
    expect(parseServerContextLimit(undefined, undefined)).toBeNull()
    expect(parseServerContextLimit({ error: {} })).toBeNull()
    expect(parseServerContextLimit('a plain string')).toBeNull()
  })
})

describe('what a learned limit belongs to', () => {
  it('is remembered against its exact endpoint', () => {
    rememberServerLimit(local, {
      contextTokens: 8192,
      requestTokens: 9001,
      via: 'structured-field',
    })
    expect(serverReportedLimit(local)?.contextTokens).toBe(8192)
  })

  /// The same model id behind a different server is a different window: a
  /// `--fit` on a small machine, a different quantisation, a different `-c`.
  it('does not carry over to another endpoint, model or provider', () => {
    rememberServerLimit(local, {
      contextTokens: 8192,
      requestTokens: null,
      via: 'structured-field',
    })
    expect(
      serverReportedLimit({ ...local, baseUrl: 'http://localhost:1234/v1' })
    ).toBeNull()
    expect(serverReportedLimit({ ...local, model: 'qwen3-32b' })).toBeNull()
    expect(serverReportedLimit({ ...local, provider: 'openai' })).toBeNull()
  })

  it('is forgotten when its endpoint is reconfigured', () => {
    rememberServerLimit(local, {
      contextTokens: 8192,
      requestTokens: null,
      via: 'structured-field',
    })
    forgetServerLimit(local)
    expect(serverReportedLimit(local)).toBeNull()
  })

  it('stores nothing when the refusal reported nothing', () => {
    expect(rememberServerLimit(local, null)).toBeNull()
    expect(serverReportedLimit(local)).toBeNull()
  })

  it('keys on all three parts of the binding', () => {
    expect(bindingKey(local)).toContain('llamacpp')
    expect(bindingKey(local)).toContain('http://llm-host:8080/v1')
    expect(bindingKey(local)).toContain('qwen3-8b')
    expect(bindingKey({ ...local, model: 'other' })).not.toBe(bindingKey(local))
  })

  it('records when it was learned and how', () => {
    const entry = rememberServerLimit(
      local,
      { contextTokens: 8192, requestTokens: 9001, via: 'known-message' },
      1_700_000_000_000
    )
    expect(entry).toMatchObject({
      learnedAtMs: 1_700_000_000_000,
      via: 'known-message',
      binding: local,
    })
  })
})

describe('recovering from the refusal', () => {
  const limit = {
    contextTokens: 8192,
    requestTokens: 20000,
    via: 'structured-field' as const,
    binding: local,
    learnedAtMs: 1,
  }

  it('compacts once and retries', () => {
    expect(
      planRecovery({ limit, alreadyRetried: false, compactedTokens: 4000 })
    ).toEqual({ action: 'retry-after-compaction', limit })
  })

  /// A retry loop against a server that keeps refusing is worse than the error
  /// it is trying to avoid.
  it('never retries twice', () => {
    expect(planRecovery({ limit, alreadyRetried: true })).toEqual({
      action: 'report',
      reason: 'already-retried',
    })
  })

  it('does not retry when compaction cannot get under the window', () => {
    expect(
      planRecovery({ limit, alreadyRetried: false, compactedTokens: 8192 })
    ).toEqual({ action: 'report', reason: 'nothing-to-compact' })
    expect(
      planRecovery({ limit, alreadyRetried: false, compactedTokens: 9000 })
    ).toEqual({ action: 'report', reason: 'nothing-to-compact' })
  })

  it('reports the original error when nothing was learned', () => {
    expect(planRecovery({ limit: null, alreadyRetried: false })).toEqual({
      action: 'report',
      reason: 'no-limit-reported',
    })
  })

  it('retries when the compacted size is unknown, because it may still fit', () => {
    expect(
      planRecovery({ limit, alreadyRetried: false, compactedTokens: null })
    ).toEqual({ action: 'retry-after-compaction', limit })
  })
})
