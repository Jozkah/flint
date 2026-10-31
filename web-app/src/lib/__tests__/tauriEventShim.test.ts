// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const NL = String.fromCharCode(10)

function sse(blocks: string[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(blocks.join(NL + NL) + NL + NL)
  // Split mid-event, the way a network delivers it.
  const cut = Math.floor(bytes.length / 2)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut))
      controller.enqueue(bytes.slice(cut))
      controller.close()
    },
  })
}

describe('browser event bus', () => {
  it('delivers emitTo to listeners in this page (one window in a browser)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }))
    const shim = (await import('@/lib/tauriEventShim')) as Record<string, unknown>
    expect(typeof shim.emitTo).toBe('function')
    const { listen } = await import('@/lib/tauriEventShim')
    const seen: unknown[] = []
    await listen<string>('to-main', (e) => seen.push(e.payload))
    await (shim.emitTo as (t: string, e: string, p?: unknown) => Promise<void>)('main', 'to-main', 'x')
    expect(seen).toEqual(['x'])
  })

  it('delivers local emits to listeners and stops after unlisten', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, headers: new Headers() }))
    const { listen, emit } = await import('@/lib/tauriEventShim')
    const seen: unknown[] = []
    const unlisten = await listen<string>('local', (e) => seen.push(e.payload))
    await emit('local', 'a')
    unlisten()
    await emit('local', 'b')
    expect(seen).toEqual(['a'])
  })

  it('delivers events the server streams, skipping keepalives and bad lines', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      redirected: false,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sse([
        ': connected',
        'data: {"event":"llamacpp-model-load-progress","payload":{"model":"m1","value":0.5}}',
        'data: not json',
        ': keepalive',
        'data: {"event":"other","payload":1}',
      ]),
    })
    vi.stubGlobal('fetch', fetch)
    const { listen } = await import('@/lib/tauriEventShim')
    const progress: unknown[] = []
    await listen<{ model: string; value: number }>('llamacpp-model-load-progress', (e) =>
      progress.push(e.payload)
    )
    await vi.waitFor(() => expect(progress).toHaveLength(1))
    expect(progress[0]).toEqual({ model: 'm1', value: 0.5 })
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/events')
  })

  it('reads frames with CRLF line ends (LIBC-042)', async () => {
    const CRLF = String.fromCharCode(13) + NL
    const text = 'data: {"event":"crlf","payload":7}' + CRLF + CRLF
    const bytes = new TextEncoder().encode(text)
    // Cut between the CR and the LF.
    const cut = text.indexOf(CRLF) + 1
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut))
        controller.enqueue(bytes.slice(cut))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        redirected: false,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body,
      })
    )
    const { listen } = await import('@/lib/tauriEventShim')
    const seen: unknown[] = []
    await listen<number>('crlf', (e) => seen.push(e.payload))
    await vi.waitFor(() => expect(seen).toEqual([7]))
  })

  it('does not treat a sign-in page as an event stream', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      redirected: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      body: sse(['<html>']),
    })
    vi.stubGlobal('fetch', fetch)
    const { listen } = await import('@/lib/tauriEventShim')
    const seen: unknown[] = []
    await listen('x', (e) => seen.push(e))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(seen).toEqual([])
  })
})
