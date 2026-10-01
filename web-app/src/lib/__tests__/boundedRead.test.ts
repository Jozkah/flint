import { describe, it, expect, vi, afterEach } from 'vitest'
import { readTextBounded, bytesLookBinary } from '../boundedRead'

const stream = (chunks: Uint8Array[], headers: Record<string, string> = {}, status = 200) => {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++])
      else c.close()
    },
  })
  return new Response(body, { status, headers })
}
const enc = (s: string) => new TextEncoder().encode(s)

afterEach(() => vi.unstubAllGlobals())

describe('readTextBounded', () => {
  it('reads small text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([enc('hello')])))
    expect(await readTextBounded('x')).toEqual({ status: 'ready', content: 'hello' })
  })
  it('reports 404 as missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([], {}, 404)))
    expect(await readTextBounded('x')).toEqual({ status: 'missing' })
  })
  it('detects binary from the first chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([new Uint8Array([1, 0, 2])])))
    expect(await readTextBounded('x')).toEqual({ status: 'binary' })
  })
  it('stops at the cap with a truncated preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([enc('a'.repeat(60)), enc('b'.repeat(60))])))
    const r = await readTextBounded('x', { maxBytes: 100 })
    expect(r.status).toBe('oversized')
    if (r.status === 'oversized') {
      expect(r.size).toBe(120)
      expect(r.preview.startsWith('aaa')).toBe(true)
    }
  })
  it('refuses on declared length without reading the body', async () => {
    const res = stream([enc('x')], { 'content-length': '999999999' })
    vi.stubGlobal('fetch', vi.fn(async () => res))
    const r = await readTextBounded('x')
    expect(r.status).toBe('oversized')
  })
  it('reports an aborted read', async () => {
    const ac = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { ac.abort(); throw new Error('x') }))
    expect(await readTextBounded('x', { signal: ac.signal })).toEqual({ status: 'error', message: 'aborted' })
  })
  it('sniffs NUL', () => {
    expect(bytesLookBinary(new Uint8Array([65, 0]))).toBe(true)
    expect(bytesLookBinary(enc('text'))).toBe(false)
  })
})
