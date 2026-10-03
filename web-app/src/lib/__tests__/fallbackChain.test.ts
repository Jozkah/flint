import { describe, expect, it } from 'vitest'
import {
  fallbackRef,
  parseFallbackRef,
  resolveFallbackChain,
  shouldFallback,
} from '../fallbackChain'

const providers = [
  { provider: 'llamacpp', models: [{ id: 'gemma' }, { id: 'qwen' }] },
  { provider: 'anthropic', models: [{ id: 'sonnet' }] },
]

describe('fallback refs', () => {
  it('round-trips provider and model id', () => {
    expect(parseFallbackRef(fallbackRef('llamacpp', 'a::b'))).toEqual({
      provider: 'llamacpp',
      modelId: 'a::b',
    })
    expect(parseFallbackRef('nope')).toBeNull()
    expect(parseFallbackRef('p::')).toBeNull()
  })
})

describe('resolveFallbackChain', () => {
  const current = { provider: 'llamacpp', modelId: 'gemma' }

  it('keeps the configured order and drops the current model', () => {
    const chain = resolveFallbackChain(
      ['llamacpp::gemma', 'llamacpp::qwen', 'anthropic::sonnet'],
      current,
      providers
    )
    expect(chain.map((c) => c.selectedModel.id)).toEqual(['qwen', 'sonnet'])
    expect(chain[1].selectedProvider).toBe('anthropic')
  })

  it('skips duplicates, malformed and uninstalled entries', () => {
    const chain = resolveFallbackChain(
      ['llamacpp::qwen', 'llamacpp::qwen', 'garbage', 'llamacpp::gone', 'ghost::x'],
      current,
      providers
    )
    expect(chain.map((c) => c.selectedModel.id)).toEqual(['qwen'])
  })

  it('is empty without a setting', () => {
    expect(resolveFallbackChain([], current, providers)).toEqual([])
  })
})

describe('shouldFallback', () => {
  it('falls back on overload, outage and model-not-loaded errors', () => {
    expect(shouldFallback(new Error('Overloaded'))).toBe(true)
    expect(shouldFallback('Service Unavailable')).toBe(true)
    expect(shouldFallback(new Error('fetch failed'))).toBe(true)
    expect(shouldFallback(new Error('HTTP 503 from server'))).toBe(true)
    expect(shouldFallback(new Error('Model gemma is not loaded'))).toBe(true)
    expect(shouldFallback({ statusCode: 429, message: 'slow down' })).toBe(true)
    expect(shouldFallback({ status: 500, message: 'boom' })).toBe(true)
  })

  it('does not fall back on a stop', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(shouldFallback(abort)).toBe(false)
    expect(shouldFallback(new Error('Overloaded'), true)).toBe(false)
  })

  it('does not fall back on content or client errors', () => {
    expect(shouldFallback({ statusCode: 400, message: 'invalid request' })).toBe(false)
    expect(shouldFallback(new Error('HTTP 401 invalid api key'))).toBe(false)
    expect(shouldFallback(new Error('Something odd happened'))).toBe(false)
  })

  it('leaves oversized prompts to compaction', () => {
    expect(
      shouldFallback(new Error('request exceeds the available context size.'))
    ).toBe(false)
  })
})
