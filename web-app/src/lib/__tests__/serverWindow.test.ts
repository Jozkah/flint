import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/providerFetch', () => ({ providerFetch: h.fetch }))

import {
  fetchServerWindow,
  modelsUrl,
  parseModelsWindow,
  parseServerWindow,
  propsUrl,
  resetServerWindowCache,
} from '@/lib/serverWindow'

const answer = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) })

describe('reading a server window', () => {
  beforeEach(() => {
    resetServerWindowCache()
    h.fetch.mockReset()
  })

  it('asks the server origin, whatever path the base URL carries', () => {
    expect(propsUrl('http://127.0.0.1:8556/v1')).toBe(
      'http://127.0.0.1:8556/props'
    )
    expect(propsUrl('http://192.168.1.5:8080')).toBe(
      'http://192.168.1.5:8080/props'
    )
    expect(propsUrl('not a url')).toBeNull()
    expect(propsUrl(undefined)).toBeNull()
  })

  it('reads the window the server launched with', () => {
    expect(
      parseServerWindow({ default_generation_settings: { n_ctx: 200000 } })
    ).toBe(200000)
    expect(parseServerWindow({ n_ctx: 8192 })).toBe(8192)
    // Zero and nonsense are not a window.
    expect(
      parseServerWindow({ default_generation_settings: { n_ctx: 0 } })
    ).toBeNull()
    expect(parseServerWindow(null)).toBeNull()
    expect(parseServerWindow({})).toBeNull()
  })

  it('probes a server on this machine and returns its window', async () => {
    h.fetch.mockReturnValue(
      answer({ default_generation_settings: { n_ctx: 262144 } })
    )
    expect(await fetchServerWindow('http://127.0.0.1:8000/v1')).toBe(262144)
    expect(h.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/props',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('probes one on the local network too', async () => {
    h.fetch.mockReturnValue(answer({ n_ctx: 32768 }))
    expect(await fetchServerWindow('http://192.168.1.20:8080/v1')).toBe(32768)
  })

  it('never calls a hosted provider', async () => {
    expect(await fetchServerWindow('https://api.openai.com/v1')).toBeNull()
    expect(await fetchServerWindow('https://openrouter.ai/api/v1')).toBeNull()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('treats a server that does not answer as having no window', async () => {
    h.fetch.mockReturnValue(answer({}, false))
    expect(await fetchServerWindow('http://127.0.0.1:8000/v1')).toBeNull()
    resetServerWindowCache()
    h.fetch.mockRejectedValue(new Error('refused'))
    expect(await fetchServerWindow('http://127.0.0.1:8000/v1')).toBeNull()
  })

  it('asks once for a counter that renders often', async () => {
    h.fetch.mockReturnValue(answer({ n_ctx: 4096 }))
    await Promise.all([
      fetchServerWindow('http://127.0.0.1:8000/v1'),
      fetchServerWindow('http://127.0.0.1:8000/v1'),
    ])
    await fetchServerWindow('http://127.0.0.1:8000/v1')
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  describe('vLLM, which has no /props', () => {
    const list = {
      data: [
        { id: 'swift15-qwen3.8-27b', max_model_len: 262144 },
        { id: 'qwen3.8-flash-next', max_model_len: 245000 },
      ],
    }

    it('finds its model list from the base URL as typed', () => {
      expect(modelsUrl('http://192.168.1.9:8559/v1')).toBe(
        'http://192.168.1.9:8559/v1/models'
      )
      expect(modelsUrl('http://192.168.1.9:8559/v1/')).toBe(
        'http://192.168.1.9:8559/v1/models'
      )
      expect(modelsUrl('http://192.168.1.9:8559')).toBe(
        'http://192.168.1.9:8559/v1/models'
      )
      expect(modelsUrl('nope')).toBeNull()
    })

    it('reads max_model_len for the model the chat uses', () => {
      expect(parseModelsWindow(list, 'qwen3.8-flash-next')).toBe(245000)
      expect(parseModelsWindow(list, 'swift15-qwen3.8-27b')).toBe(262144)
    })

    it('names no window for a model it does not list, among several', () => {
      expect(parseModelsWindow(list, 'pxa-qwen3.8-27b')).toBeNull()
      expect(parseModelsWindow({ data: [] }, 'x')).toBeNull()
      expect(parseModelsWindow(null, 'x')).toBeNull()
    })

    it('takes the only model a single-model server lists', () => {
      expect(
        parseModelsWindow({ data: [{ id: 'a', max_model_len: 8192 }] }, 'other')
      ).toBe(8192)
    })

    it('falls back to the model list when /props is not there', async () => {
      h.fetch.mockImplementation((url: string) =>
        url.endsWith('/props') ? answer({}, false) : answer(list)
      )
      expect(
        await fetchServerWindow('http://192.168.1.9:8557/v1', 'qwen3.8-flash-next')
      ).toBe(245000)
      expect(h.fetch).toHaveBeenCalledWith(
        'http://192.168.1.9:8557/v1/models',
        expect.objectContaining({ method: 'GET' })
      )
    })

    it('probes a bare hostname too: a LAN box named by the user, not a hosted service', async () => {
      h.fetch.mockImplementation((url: string) =>
        url.endsWith('/props') ? answer({}, false) : answer(list)
      )
      expect(
        await fetchServerWindow('http://v100:8559/v1', 'qwen3.8-flash-next')
      ).toBe(245000)
    })

    it('keeps one answer per model when a box serves several', async () => {
      h.fetch.mockImplementation((url: string) =>
        url.endsWith('/props') ? answer({}, false) : answer(list)
      )
      const a = await fetchServerWindow('http://192.168.1.9:8559/v1', 'swift15-qwen3.8-27b')
      const b = await fetchServerWindow('http://192.168.1.9:8559/v1', 'qwen3.8-flash-next')
      expect([a, b]).toEqual([262144, 245000])
    })
  })
})
