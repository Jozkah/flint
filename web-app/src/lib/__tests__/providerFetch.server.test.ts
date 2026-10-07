// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableServerTransport, providerFetch, runtimeProviderFetch } from '@/lib/providerFetch'

afterEach(() => vi.unstubAllGlobals())

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + String.fromCharCode(10))
const b64 = (text: string) => btoa(text)

/** A server answer split mid-line, the way a network delivers it. */
function ndjsonBody(lines: Uint8Array[]): ReadableStream<Uint8Array> {
  const all = lines.reduce((acc, line) => [...acc, ...line], [] as number[])
  const cut = Math.floor(all.length / 2)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(all.slice(0, cut)))
      controller.enqueue(Uint8Array.from(all.slice(cut)))
      controller.close()
    },
  })
}

describe('provider transport through the Flint server', () => {
  it('streams a provider response and keeps the request shape', async () => {
    enableServerTransport()
    expect(runtimeProviderFetch()).toBe(providerFetch)
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      body: ndjsonBody([
        encode({ kind: 'head', status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream' }, peer: null, snapshot: null }),
        encode({ kind: 'data', b64: b64('data: hel') }),
        encode({ kind: 'data', b64: b64('lo') }),
        encode({ kind: 'end' }),
      ]),
    })
    vi.stubGlobal('fetch', fetch)

    const response = await providerFetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer k', 'x-jan-session': 's1' },
      body: '{"model":"m"}',
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: hello')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/v1/provider/stream')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    const sent = JSON.parse(init.body)
    expect(sent).toMatchObject({
      url: 'https://api.example.com/v1/chat/completions',
      method: 'POST',
      body: '{"model":"m"}',
      session: 's1',
    })
    expect(sent.headers).toEqual({ Authorization: 'Bearer k' })
    expect(sent.streamId).toMatch(/^s-/)
  })

  it('rejects when the server reports a transport error before any response', async () => {
    enableServerTransport()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        redirected: false,
        body: ndjsonBody([encode({ kind: 'error', message: 'no route to host' })]),
      })
    )
    await expect(providerFetch('https://down.example.com/v1/models')).rejects.toThrow('no route to host')
  })
})
