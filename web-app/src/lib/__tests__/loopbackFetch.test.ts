// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('loopback fetches in the browser build', () => {
  it('sends other loopback ports through the server, and leaves the page itself alone', async () => {
    const original = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({ start: (c) => c.close() }),
    })
    vi.stubGlobal('fetch', original)
    const { enableServerTransport } = await import('@/lib/providerFetch')
    enableServerTransport()
    const here = new URL(globalThis.location.href)

    // The page's own server, under either loopback name: untouched.
    const sameHost = `http://127.0.0.1:${here.port}/healthz`
    await globalThis.fetch(sameHost).catch(() => {})
    expect(original.mock.calls[0][0]).toBe(sameHost)

    // A different loopback port is the server machine's own service (the engine).
    // (Not awaited: the stand-in server never answers the stream.)
    void globalThis.fetch('http://localhost:39271/v1/models').catch(() => {})
    await vi.waitFor(() => expect(original.mock.calls[1]?.[0]).toBe('/api/v1/provider/stream'))

    // Relative URLs and other hosts are untouched.
    await globalThis.fetch('/api/v1/threads').catch(() => {})
    expect(original.mock.calls[2][0]).toBe('/api/v1/threads')
    await globalThis.fetch('https://api.example.com/v1').catch(() => {})
    expect(original.mock.calls[3][0]).toBe('https://api.example.com/v1')
  })
})
