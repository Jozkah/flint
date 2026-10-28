import { describe, it, expect, vi } from 'vitest'

const invoke = vi.fn()
class FakeChannel<T> {
  onmessage: ((m: T) => void) | null = null
}
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: FakeChannel,
}))

const { decodeStreamMessage } = await import('@/lib/providerFetch')

describe('decodeStreamMessage', () => {
  it('passes JSON chunks through untouched', () => {
    const end = { kind: 'end' }
    expect(decodeStreamMessage(end)).toBe(end)
    const data = { kind: 'data', b64: 'aGk=' }
    expect(decodeStreamMessage(data)).toBe(data)
  })

  it('turns an ArrayBuffer into raw bytes', () => {
    const buf = new Uint8Array([104, 105]).buffer
    const chunk = decodeStreamMessage(buf)
    expect(chunk).toEqual({ kind: 'raw', bytes: new Uint8Array([104, 105]) })
  })

  it('turns a typed-array view into raw bytes without copying the whole buffer', () => {
    const whole = new Uint8Array([0, 104, 105, 0])
    const view = new Uint8Array(whole.buffer, 1, 2)
    expect(decodeStreamMessage(view)).toEqual({
      kind: 'raw',
      bytes: new Uint8Array([104, 105]),
    })
  })

  it('turns a plain byte array into raw bytes', () => {
    expect(decodeStreamMessage([104, 105])).toEqual({
      kind: 'raw',
      bytes: new Uint8Array([104, 105]),
    })
  })

  it('keeps a multi-byte character split across raw messages intact once joined', () => {
    const word = new TextEncoder().encode('café')
    const first = decodeStreamMessage(word.slice(0, word.length - 1).buffer)
    const second = decodeStreamMessage(word.slice(word.length - 1).buffer)
    if (first.kind !== 'raw' || second.kind !== 'raw') throw new Error('expected raw')
    const joined = new Uint8Array(first.bytes.length + second.bytes.length)
    joined.set(first.bytes, 0)
    joined.set(second.bytes, first.bytes.length)
    expect(new TextDecoder().decode(joined)).toBe('café')
  })
})
