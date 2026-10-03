import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  contextFromModelEntry,
  contextFromProps,
  findModelEntry,
  detectContextWindow,
} from '../detectContextWindow'
import { forgetAllServerLimits, rememberServerLimit } from '../contextLimitRecovery'

describe('contextFromModelEntry', () => {
  it.each([
    [{ context_length: 131072 }, 131072],
    [{ context_window: 200000 }, 200000],
    [{ max_context_length: 8192 }, 8192],
    [{ max_model_len: 32768 }, 32768],
    [{ max_input_tokens: 100000 }, 100000],
    [{ inputTokenLimit: 1048576 }, 1048576],
    [{ top_provider: { context_length: 65536 } }, 65536],
    [{ meta: { n_ctx: 4096 } }, 4096],
    [{ context_length: '16384' }, 16384],
  ])('reads %j', (entry, tokens) => {
    expect(contextFromModelEntry(entry)).toBe(tokens)
  })

  it('does not read the reply cap as the window', () => {
    expect(contextFromModelEntry({ max_tokens: 4096, max_output_tokens: 8192 })).toBeNull()
  })

  it('rejects zero, negatives, NaN and junk', () => {
    expect(contextFromModelEntry({ context_length: 0 })).toBeNull()
    expect(contextFromModelEntry({ context_length: -5 })).toBeNull()
    expect(contextFromModelEntry({ context_length: 'lots' })).toBeNull()
    expect(contextFromModelEntry(null)).toBeNull()
    expect(contextFromModelEntry('x')).toBeNull()
  })
})

describe('findModelEntry', () => {
  const payload = {
    data: [
      { id: 'a', context_length: 1000 },
      { id: 'b', context_length: 2000 },
    ],
  }
  it('finds the entry by id', () => {
    expect(findModelEntry(payload, 'b')).toEqual({ id: 'b', context_length: 2000 })
  })
  it('names no entry when several exist and none match', () => {
    expect(findModelEntry(payload, 'c')).toBeNull()
  })
  it('uses the only entry of a one-model list', () => {
    expect(findModelEntry({ data: [{ id: 'solo', max_model_len: 5 }] }, 'x')).toEqual({
      id: 'solo',
      max_model_len: 5,
    })
  })
  it('reads llama.cpp style models arrays and bare arrays', () => {
    expect(findModelEntry({ models: [{ name: 'm', n_ctx: 9 }] }, 'm')).toEqual({
      name: 'm',
      n_ctx: 9,
    })
    expect(findModelEntry([{ id: 'z' }, { id: 'y' }], 'y')).toEqual({ id: 'y' })
  })
  it('copes with nonsense', () => {
    expect(findModelEntry(null, 'a')).toBeNull()
    expect(findModelEntry({}, 'a')).toBeNull()
  })
})

describe('contextFromProps', () => {
  it('reads the extension shape and the raw /props body', () => {
    expect(contextFromProps({ nCtx: 8192 })).toBe(8192)
    expect(contextFromProps({ default_generation_settings: { n_ctx: 4096 } })).toBe(4096)
    expect(contextFromProps({ n_ctx: 2048 })).toBe(2048)
  })
  it('has no answer for empty or zero props', () => {
    expect(contextFromProps({})).toBeNull()
    expect(contextFromProps({ nCtx: 0 })).toBeNull()
    expect(contextFromProps(undefined)).toBeNull()
  })
})

describe('detectContextWindow', () => {
  beforeEach(() => forgetAllServerLimits())

  it('asks nothing when no model is selected', async () => {
    const r = await detectContextWindow({ providerId: 'openai', modelId: '' })
    expect(r).toMatchObject({ unknown: true })
  })

  it('prefers the loaded runtime for llama.cpp', async () => {
    const getRuntimeProps = vi.fn().mockResolvedValue({ nCtx: 16384 })
    const r = await detectContextWindow({
      providerId: 'llamacpp',
      modelId: 'm',
      model: { id: 'm', settings: { ctx_len: { controller_props: { value: 4096 } } } },
      getRuntimeProps,
    })
    expect(r).toEqual({ tokens: 16384, source: 'local-runtime' })
  })

  it('falls back to the model setting when the model is not loaded', async () => {
    const r = await detectContextWindow({
      providerId: 'llamacpp',
      modelId: 'm',
      model: { id: 'm', settings: { ctx_len: { controller_props: { value: 4096 } } } },
      getRuntimeProps: () => Promise.resolve(undefined),
    })
    expect(r).toEqual({ tokens: 4096, source: 'model-settings' })
  })

  it('survives a runtime that throws', async () => {
    const r = await detectContextWindow({
      providerId: 'llamacpp',
      modelId: 'unlisted-thing',
      getRuntimeProps: () => Promise.reject(new Error('router down')),
    })
    expect(r).toMatchObject({ unknown: true })
  })

  it('uses what the provider entry in the app says', async () => {
    const r = await detectContextWindow({
      providerId: 'openrouter',
      modelId: 'x/y',
      model: { id: 'x/y', context_length: 128000 },
      provider: { provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1' },
    })
    expect(r).toEqual({ tokens: 128000, source: 'provider-metadata' })
  })

  it('asks the provider list for a remote model', async () => {
    const fetchModelEntry = vi.fn().mockResolvedValue({ id: 'gpt', context_window: 400000 })
    const r = await detectContextWindow({
      providerId: 'openai',
      modelId: 'gpt',
      model: { id: 'gpt' },
      provider: { provider: 'openai', base_url: 'https://api.openai.com/v1' },
      fetchModelEntry,
    })
    expect(fetchModelEntry).toHaveBeenCalledWith('gpt')
    expect(r).toEqual({ tokens: 400000, source: 'provider-list' })
  })

  it('tries a local custom server after the list says nothing', async () => {
    const r = await detectContextWindow({
      providerId: 'custom',
      modelId: 'local-model-unknown',
      provider: { provider: 'custom', base_url: 'http://127.0.0.1:8080/v1' },
      fetchModelEntry: () => Promise.resolve({ id: 'local-model-unknown' }),
      fetchLocalServerWindow: () => Promise.resolve(24576),
    })
    expect(r).toEqual({ tokens: 24576, source: 'local-server' })
  })

  it('does not read a remote /models for llama.cpp', async () => {
    const fetchModelEntry = vi.fn()
    await detectContextWindow({
      providerId: 'llamacpp',
      modelId: 'nothing-known',
      provider: { provider: 'llamacpp', base_url: 'http://127.0.0.1:1/v1' },
      fetchModelEntry,
    })
    expect(fetchModelEntry).not.toHaveBeenCalled()
  })

  it('uses a window a server named in a refusal first', async () => {
    rememberServerLimit(
      { provider: 'custom', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm' },
      { contextTokens: 6000 } as never
    )
    const r = await detectContextWindow({
      providerId: 'custom',
      modelId: 'm',
      model: { id: 'm', context_length: 99999 },
      provider: { provider: 'custom', base_url: 'http://127.0.0.1:8080/v1' },
    })
    expect(r).toEqual({ tokens: 6000, source: 'server-response' })
  })

  it('uses the bundled table last', async () => {
    const r = await detectContextWindow({
      providerId: 'custom',
      modelId: 'Llama-3.1-8B-Instruct',
      provider: { provider: 'custom', base_url: 'http://10.0.0.5/v1' },
      fetchModelEntry: () => Promise.resolve(null),
      fetchLocalServerWindow: () => Promise.resolve(null),
    })
    expect(r).toEqual({ tokens: 131072, source: 'bundled' })
  })

  it('reports unknown honestly rather than inventing a number', async () => {
    const r = await detectContextWindow({
      providerId: 'custom',
      modelId: 'totally-new-model',
      provider: { provider: 'custom', base_url: 'https://example.test/v1' },
      fetchModelEntry: () => Promise.reject(new Error('boom')),
    })
    expect(r).toHaveProperty('unknown', true)
    expect('tokens' in r).toBe(false)
    expect((r as { reason: string }).reason.length).toBeGreaterThan(0)
  })
})
