import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/providerFetch', () => ({ providerFetch: h.fetch }))

import {
  fetchServerWindow,
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
})
