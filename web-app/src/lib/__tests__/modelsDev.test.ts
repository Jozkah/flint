import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildIndex,
  clearModelsDevCache,
  idCandidates,
  loadModelsDevIndex,
  matchModelsDev,
  stripVariantSuffix,
  type ModelsDevIndex,
} from '../modelsDev'

const index: ModelsDevIndex = {
  openai: {
    'gpt-4.1': [1047576, 32768],
    'gpt-5.4': [1050000, 128000],
    'o3-mini': [200000, 100000],
  },
  anthropic: { 'claude-sonnet-4-5': [200000, 64000] },
  google: { 'gemini-2.5-pro': [1048576, 65536] },
  openrouter: { 'nousresearch/hermes-4-405b': [131072, 0] },
  azure: { 'gpt-4.1': [1047576, 32768], 'only-azure': [8000, 2000] },
  helicone: { 'gpt-4.1': [1047576, 32768], 'gpt-5.4': [900000, 100000] },
  infer: { 'infer/gpt-5.6-sol:official': [400000, 128000] },
}

describe('stripVariantSuffix', () => {
  it.each([
    ['gpt-5.4:flex', 'gpt-5.4'],
    ['gpt-5.4:priority', 'gpt-5.4'],
    ['openai/gpt-5.4:flex', 'openai/gpt-5.4'],
    ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'anthropic.claude-3-5-sonnet-20241022-v2'],
    ['model:free:extended', 'model'],
    ['gpt-5.4', 'gpt-5.4'],
  ])('%s -> %s', (raw, want) => {
    expect(stripVariantSuffix(raw)).toBe(want)
  })
})

describe('idCandidates', () => {
  it('orders the id as given, then without its suffix, then without prefixes', () => {
    expect(idCandidates('OpenAI/GPT-5.4:flex')).toEqual([
      'openai/gpt-5.4:flex',
      'gpt-5.4:flex',
      'openai/gpt-5.4',
      'gpt-5.4',
    ])
  })
  it('handles several prefix segments', () => {
    expect(idCandidates('a/b/model')).toEqual(['a/b/model', 'b/model', 'model'])
  })
  it('returns nothing for a blank id', () => {
    expect(idCandidates('  ')).toEqual([])
  })
})

describe('matchModelsDev', () => {
  it('matches under the own provider of the model', () => {
    expect(matchModelsDev(index, 'openai', 'gpt-5.4')).toMatchObject({
      provider: 'openai',
      contextWindow: 1050000,
      maxOutputTokens: 128000,
    })
  })

  it('prefers the own provider over others that list the id differently', () => {
    expect(matchModelsDev(index, 'openai', 'gpt-5.4')?.contextWindow).toBe(1050000)
    expect(matchModelsDev(index, 'helicone', 'gpt-5.4')?.contextWindow).toBe(900000)
  })

  it.each(['gpt-5.4:flex', 'gpt-5.4:priority'])('strips %s before matching', (id) => {
    expect(matchModelsDev(index, 'openai', id)).toMatchObject({
      modelId: 'gpt-5.4',
      maxOutputTokens: 128000,
    })
  })

  it('maps Flint provider names to models.dev ids', () => {
    expect(matchModelsDev(index, 'gemini', 'gemini-2.5-pro')?.provider).toBe('google')
  })

  it('handles provider-prefixed ids', () => {
    expect(matchModelsDev(index, 'openrouter', 'openai/gpt-5.4:flex')).toMatchObject({
      provider: 'openai',
      modelId: 'gpt-5.4',
    })
    expect(matchModelsDev(index, 'custom', 'anthropic/claude-sonnet-4-5')?.provider).toBe(
      'anthropic'
    )
  })

  it('tries an exact id first, even when it contains a colon', () => {
    expect(matchModelsDev(index, 'infer', 'infer/gpt-5.6-sol:official')).toMatchObject({
      modelId: 'infer/gpt-5.6-sol:official',
      contextWindow: 400000,
    })
  })

  it('matches an openrouter-style id as listed', () => {
    expect(matchModelsDev(index, 'openrouter', 'nousresearch/hermes-4-405b')).toMatchObject({
      contextWindow: 131072,
      maxOutputTokens: null,
    })
  })

  it('is case-insensitive', () => {
    expect(matchModelsDev(index, 'openai', 'GPT-4.1')?.provider).toBe('openai')
  })

  it('falls back to id alone when exactly one provider has it', () => {
    expect(matchModelsDev(index, 'my-proxy', 'only-azure')).toMatchObject({
      provider: 'azure',
      contextWindow: 8000,
    })
  })

  it('falls back across providers when every one agrees', () => {
    expect(matchModelsDev(index, 'my-proxy', 'gpt-4.1')?.maxOutputTokens).toBe(32768)
  })

  it('gives no answer when providers disagree', () => {
    expect(matchModelsDev(index, 'my-proxy', 'gpt-5.4')).toBeNull()
  })

  it('gives no answer for an unknown model', () => {
    expect(matchModelsDev(index, 'openai', 'does-not-exist:flex')).toBeNull()
  })
})

describe('buildIndex', () => {
  it('keeps the limits and skips malformed entries', () => {
    expect(
      buildIndex({
        p: {
          models: {
            a: { limit: { context: 1000, output: 500, input: 900 } },
            b: { limit: { context: 'x' } },
            c: {},
            d: { limit: { context: 0, output: 64 } },
          },
        },
        q: { models: { z: {} } },
        r: null,
      })
    ).toEqual({ p: { a: [1000, 500], d: [0, 64] } })
  })
})

describe('loadModelsDevIndex', () => {
  beforeEach(() => clearModelsDevCache())

  const okResponse = () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ p: { models: { a: { limit: { context: 10, output: 5 } } } } }),
    }) as Response

  it('downloads once, shares concurrent calls, then serves the cache', async () => {
    const fetchImpl = vi.fn(async () => okResponse())
    const asFetch = fetchImpl as unknown as typeof fetch
    const [a, b] = await Promise.all([loadModelsDevIndex(asFetch), loadModelsDevIndex(asFetch)])
    expect(a).toEqual({ p: { a: [10, 5] } })
    expect(b).toBe(a)
    await loadModelsDevIndex(asFetch)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://models.dev/api.json')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit' })
    expect(init.body).toBeUndefined()
  })

  it('rejects when offline with nothing cached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(loadModelsDevIndex(fetchImpl)).rejects.toThrow('Failed to fetch')
  })

  it('serves a stale copy when a refresh fails', async () => {
    const day = 24 * 60 * 60 * 1000
    await loadModelsDevIndex(vi.fn(async () => okResponse()) as unknown as typeof fetch, 0)
    const offline = vi.fn(async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    await expect(loadModelsDevIndex(offline, 30 * day)).resolves.toEqual({
      p: { a: [10, 5] },
    })
  })
})
