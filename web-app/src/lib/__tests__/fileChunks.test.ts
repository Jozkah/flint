import { describe, it, expect } from 'vitest'
import {
  createChunkReader,
  createLineState,
  pushText,
  stringSource,
  looksBinary,
  rowOffsets,
  visibleWindow,
  capLine,
  takeRange,
  LINE_CAP,
  type ChunkSource,
} from '../fileChunks'

function bytesSource(bytes: Uint8Array): ChunkSource & { reads: number[] } {
  const reads: number[] = []
  return {
    reads,
    size: bytes.length,
    read: async (o, l) => {
      reads.push(l)
      return bytes.slice(o, o + l)
    },
  }
}

describe('pushText', () => {
  it('cuts lines across chunks and keeps the tail until final', () => {
    const s = createLineState()
    pushText(s, 'ab\r\ncd', false)
    expect(s.lines).toEqual(['ab'])
    pushText(s, 'e\nf', false)
    expect(s.lines).toEqual(['ab', 'cde'])
    pushText(s, '', true)
    expect(s.lines).toEqual(['ab', 'cde', 'f'])
  })
})

describe('createChunkReader', () => {
  it('reads a string in chunks and never asks for more than one chunk', async () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
    const r = createChunkReader(stringSource(text), 1024)
    await r.next()
    expect(r.done).toBe(false)
    expect(r.loaded).toBe(1024)
    const first = r.state.lines.length
    expect(first).toBeGreaterThan(50)
    expect(first).toBeLessThan(200)
    while (!r.done) await r.next()
    expect(r.state.lines.length).toBe(1000)
    expect(r.state.lines[999]).toBe('line 999')
  })

  it('keeps a multi-byte character split across chunks intact', async () => {
    const bytes = new TextEncoder().encode('aé\nzü')
    const src = bytesSource(bytes)
    const r = createChunkReader(src, 2) // splits é
    while (!r.done) await r.next()
    expect(r.state.lines).toEqual(['aé', 'zü'])
    expect(Math.max(...src.reads)).toBe(2)
  })

  it('flags binary content and stops', async () => {
    const r = createChunkReader(bytesSource(new Uint8Array([80, 75, 3, 4, 0, 0, 1])), 64)
    await r.next()
    expect(r.binary).toBe(true)
    expect(r.done).toBe(true)
    expect(r.state.lines).toEqual([])
  })

  it('stays fast on a 200k-line paste: the first chunk only', async () => {
    const text = 'x'.repeat(30) + '\n'
    const big = text.repeat(200_000)
    const r = createChunkReader(stringSource(big))
    const t0 = performance.now()
    await r.next()
    expect(performance.now() - t0).toBeLessThan(500)
    expect(r.loaded).toBe(2 * 1024 * 1024)
    expect(r.state.lines.length).toBeLessThan(200_000)
  })
})

describe('looksBinary', () => {
  it('text is not binary, NUL is', () => {
    expect(looksBinary(new TextEncoder().encode('hello\tworld\n'))).toBe(false)
    expect(looksBinary(new Uint8Array([1, 0, 2]))).toBe(true)
  })
})

describe('takeRange', () => {
  it('skips to the offset in a stream that ignored Range', async () => {
    const parts = [new Uint8Array([0, 1, 2]), new Uint8Array([3, 4, 5, 6])]
    let i = 0
    let cancelled = false
    const reader = {
      read: async () =>
        i < parts.length ? { done: false, value: parts[i++] } : { done: true, value: undefined },
      cancel: async () => {
        cancelled = true
      },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>
    const out = await takeRange(reader, 2, 3)
    expect(Array.from(out)).toEqual([2, 3, 4])
    expect(cancelled).toBe(true)
  })
})

describe('windowing', () => {
  it('renders only the rows in view', () => {
    const lines = Array.from({ length: 200_000 }, () => 'abc')
    const off = rowOffsets(lines, 18, Infinity)
    expect(off[200_000]).toBe(200_000 * 18)
    const w = visibleWindow(off, 18 * 1000, 18 * 30, 5)
    expect(w).toEqual({ start: 995, end: 1036 })
  })

  it('wrapped long lines take more rows; capped unless expanded', () => {
    const lines = ['a'.repeat(250), 'b', 'c'.repeat(LINE_CAP * 3)]
    const off = rowOffsets(lines, 10, 100)
    expect(Array.from(off)).toEqual([0, 30, 40, 40 + 10 * Math.ceil((LINE_CAP + 1) / 100)])
    const exp = rowOffsets(lines, 10, 100, new Set([2]))
    expect(exp[3]).toBe(40 + 10 * Math.ceil((LINE_CAP * 3) / 100))
  })

  it('capLine cuts long lines', () => {
    const long = 'x'.repeat(LINE_CAP + 5)
    expect(capLine(long, false)).toEqual({ text: 'x'.repeat(LINE_CAP), cut: true })
    expect(capLine(long, true).cut).toBe(false)
  })
})

describe('createChunkReader with a capped range server', () => {
  it('keeps going after a short read while the known size is not reached', async () => {
    const bytes = new TextEncoder().encode('a\n'.repeat(3000))
    // The server returns at most 1000 bytes per request, like Tauri's asset protocol.
    const src = {
      size: bytes.length,
      read: async (offset: number, length: number) =>
        bytes.slice(offset, offset + Math.min(length, 1000)),
    }
    const r = createChunkReader(src, 4096)
    await r.next()
    expect(r.done).toBe(false)
    expect(r.loaded).toBe(1000)
    while (!r.done) await r.next()
    expect(r.loaded).toBe(bytes.length)
    expect(r.state.lines).toHaveLength(3000)
  })
})
