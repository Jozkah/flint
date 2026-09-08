import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Tauri bridge, stubbed at the module boundary: `invoke` records what was
// asked for, and the test drives the channel the way the Rust side would.
const invoke = vi.fn()
class FakeChannel<T> {
  onmessage: ((m: T) => void) | null = null
}
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: FakeChannel,
}))

const {
  providerFetch,
  runtimeProviderFetch,
  endpointOf,
  endpointDiagnostics,
  refreshEndpoint,
} = await import('@/lib/providerFetch')

type Chunk =
  | { kind: 'head'; status: number; statusText: string; headers: Record<string, string>; peer: string | null }
  | { kind: 'data'; b64: string }
  | { kind: 'end' }
  | { kind: 'error'; message: string }

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

/** Captures the channel the transport was handed and lets the test feed it. */
function drive() {
  let channel: FakeChannel<Chunk> | null = null
  invoke.mockImplementation(async (_cmd: string, args: { channel: FakeChannel<Chunk> }) => {
    channel = args.channel
    return undefined
  })
  return {
    // `providerFetch` awaits the request body before it invokes, so the channel
    // does not exist until the microtask queue has drained once.
    send: async (c: Chunk) => {
      for (let i = 0; !channel && i < 50; i++) await Promise.resolve()
      channel?.onmessage?.(c)
    },
    request: () => invoke.mock.calls[0][1].request,
    command: () => invoke.mock.calls[0][0],
  }
}

const OK = {
  kind: 'head' as const,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  peer: '100.86.12.4:8080',
}

describe('providerFetch', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('sends the URL exactly as configured, with no hostname rewriting', async () => {
    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/models')
    await d.send(OK)
    await d.send({ kind: 'data', b64: b64('{"data":[]}') })
    await d.send({ kind: 'end' })
    await pending

    expect(d.command()).toBe('provider_http_stream')
    // The short hostname survives. Selecting an address is the transport's job,
    // and it does it in the connector, not by editing this string.
    expect(d.request().url).toBe('http://v100:8080/v1/models')
    expect(d.request().method).toBe('GET')
  })

  it('carries the method, headers and JSON body through', async () => {
    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/chat/completions', {
      method: 'post',
      headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
      body: '{"model":"qwen3.8-27b","stream":true}',
    })
    await d.send(OK)
    await d.send({ kind: 'end' })
    await pending

    const req = d.request()
    expect(req.method).toBe('POST')
    expect(req.headers.Authorization).toBe('Bearer k')
    expect(req.body).toBe('{"model":"qwen3.8-27b","stream":true}')
  })

  it('accepts a Headers instance as well as a plain object', async () => {
    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/models', {
      headers: new Headers({ 'x-api-key': 'k' }),
    })
    await d.send(OK)
    await d.send({ kind: 'end' })
    await pending
    expect(d.request().headers['x-api-key']).toBe('k')
  })

  it('streams the body incrementally rather than after the whole response', async () => {
    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    await d.send(OK)
    const response = await pending
    // The response resolves on the head, before any body has arrived.
    expect(response.status).toBe(200)

    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    await d.send({ kind: 'data', b64: b64('data: {"a":1}\n\n') })
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('"a":1')

    await d.send({ kind: 'data', b64: b64('data: [DONE]\n\n') })
    await d.send({ kind: 'end' })
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toContain('[DONE]')
    expect((await reader.read()).done).toBe(true)
  })

  it('reassembles a multi-byte character split across two chunks', async () => {
    // Base64 framing exists precisely so a chunk boundary inside a UTF-8
    // sequence does not corrupt the token.
    const bytes = new TextEncoder().encode('café')
    const head = btoa(String.fromCharCode(...bytes.slice(0, 4)))
    const tail = btoa(String.fromCharCode(...bytes.slice(4)))

    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    await d.send(OK)
    await d.send({ kind: 'data', b64: head })
    await d.send({ kind: 'data', b64: tail })
    await d.send({ kind: 'end' })
    expect(await (await pending).text()).toBe('café')
  })

  it('keeps a real 401 or 403 as a response instead of throwing', async () => {
    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/models')
    await d.send({ ...OK, status: 403, statusText: 'Forbidden' })
    await d.send({ kind: 'data', b64: b64('no entry') })
    await d.send({ kind: 'end' })

    const response = await pending
    expect(response.ok).toBe(false)
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('no entry')
  })

  it('rejects with the transport message when nothing could be reached', async () => {
    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/models')
    await d.send({
      kind: 'error',
      message: 'v100:8080 could not connect (resolved 100.86.12.4 [tailscale]; selected 100.86.12.4)',
    })
    await expect(pending).rejects.toThrow(/could not connect/)
  })

  it('fails the body stream when the connection dies mid-response', async () => {
    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    await d.send(OK)
    const response = await pending
    await d.send({ kind: 'data', b64: b64('partial') })
    await d.send({ kind: 'error', message: 'v100:8080 failed' })
    await expect(response.text()).rejects.toThrow(/failed/)
  })

  it('gives a bodyless status no body rather than constructing an illegal Response', async () => {
    const d = drive()
    const pending = providerFetch('http://v100:8080/v1/models')
    await d.send({ ...OK, status: 204, statusText: 'No Content' })
    await d.send({ kind: 'end' })
    const response = await pending
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('refuses a body type provider APIs never use, rather than sending nothing', async () => {
    drive()
    await expect(
      providerFetch('http://v100:8080/v1/models', {
        method: 'POST',
        body: new Blob(['x']),
      })
    ).rejects.toThrow(/not supported/)
  })

  it('falls back to the platform fetch when there is no Tauri bridge', () => {
    expect(runtimeProviderFetch()).toBe(globalThis.fetch)
  })

  it('does not reach for IPC for diagnostics when there is no bridge', async () => {
    await expect(endpointDiagnostics('v100', 8080)).resolves.toBeNull()
    await refreshEndpoint('v100', 8080)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reads the endpoint that will actually be dialled out of a base URL', () => {
    expect(endpointOf('http://v100:8080/v1')).toEqual({ host: 'v100', port: 8080 })
    // The scheme's default port, because that is what gets connected to.
    expect(endpointOf('https://api.openai.com/v1')).toEqual({
      host: 'api.openai.com',
      port: 443,
    })
    expect(endpointOf('http://v100/v1')).toEqual({ host: 'v100', port: 80 })
    expect(endpointOf('not a url')).toBeNull()
  })
})
