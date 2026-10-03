import { describe, expect, it } from 'vitest'
import {
  fallbackRef,
  moveFallback,
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

  it('falls back on the desktop transport failure sentences', () => {
    expect(
      shouldFallback(
        new Error(
          "Couldn't reach the provider — the connection failed. Check the provider's Base URL and your internet connection, then try again. (http://127.0.0.1:1/v1/chat/completions) Details: error sending request for url (http://127.0.0.1:1/v1/chat/completions): client error (SendRequest): connection closed before message completed"
        )
      )
    ).toBe(true)
    expect(
      shouldFallback(
        new Error(
          'The provider took too long to respond and the request timed out. It may be overloaded or slow to start — try again.'
        )
      )
    ).toBe(true)
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

describe('shouldFallback on credential failures', () => {
  it('only moves to another provider', () => {
    const bad = new Error('Failed to create model: Invalid API key')
    expect(shouldFallback(bad)).toBe(false)
    expect(shouldFallback(bad, false, true)).toBe(true)
    expect(shouldFallback({ statusCode: 401, message: 'nope' }, false, true)).toBe(true)
    expect(shouldFallback({ statusCode: 403, message: 'nope' })).toBe(false)
  })

  it('treats a model that failed to start as unavailable', () => {
    expect(shouldFallback(new Error('Failed to create model: engine exited'))).toBe(true)
  })
})

describe('moveFallback', () => {
  const refs = ['a::1', 'b::2', 'c::3']
  it('moves an entry up or down by one', () => {
    expect(moveFallback(refs, 1, -1)).toEqual(['b::2', 'a::1', 'c::3'])
    expect(moveFallback(refs, 1, 1)).toEqual(['a::1', 'c::3', 'b::2'])
  })
  it('leaves the order alone at either end and for a bad index, without mutating', () => {
    expect(moveFallback(refs, 0, -1)).toEqual(refs)
    expect(moveFallback(refs, 2, 1)).toEqual(refs)
    expect(moveFallback(refs, 9, 1)).toEqual(refs)
    expect(refs).toEqual(['a::1', 'b::2', 'c::3'])
  })
  it('the moved order is the order the chain is walked in', () => {
    const providers = [{ provider: 'a', models: [{ id: '1' }] }, { provider: 'b', models: [{ id: '2' }] }, { provider: 'c', models: [{ id: '3' }] }]
    const chain = resolveFallbackChain(moveFallback(refs, 2, -1), { provider: 'x', modelId: 'y' }, providers)
    expect(chain.map((c) => c.selectedModel.id)).toEqual(['1', '3', '2'])
  })
})
