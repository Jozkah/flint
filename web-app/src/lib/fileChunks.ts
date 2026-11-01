/**
 * Chunked reading and windowed layout for the full file viewer. Nothing here
 * holds a whole file: a source hands out one chunk at a time, lines are cut
 * as chunks arrive, and only the rows in view are rendered.
 */

/** How much one "Load more" reads (bytes, or characters for in-memory text). */
export const CHUNK_SIZE = 2 * 1024 * 1024
/** Longer lines are cut for display until expanded. */
export const LINE_CAP = 2000
/** Bytes sniffed for a NUL to call a file binary. */
const SNIFF = 8192

export interface ChunkSource {
  /** Total size in the source's units, when known. */
  size: number | null
  /** Read `length` units from `offset`. Fewer back means the end. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<string | Uint8Array>
}

/** In-memory text (an inline paste): sliced, never copied whole. */
export function stringSource(text: string): ChunkSource {
  return {
    size: text.length,
    read: async (offset, length) => text.slice(offset, offset + length),
  }
}

/** An open whole-file stream, read on from where the last chunk stopped. */
type SequentialStream = {
  reader: ReadableStreamDefaultReader<Uint8Array>
  /** Bytes handed out (or skipped) so far. */
  pos: number
  /** Bytes read from the stream past the last chunk. */
  rest: Uint8Array | null
}

/** Collect at most `length` bytes from an open stream, keeping any excess. */
async function readOn(seq: SequentialStream, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length)
  let o = 0
  while (o < length) {
    let v = seq.rest
    seq.rest = null
    if (!v) {
      const r = await seq.reader.read()
      if (r.done) break
      v = r.value
    }
    const n = Math.min(v.length, length - o)
    out.set(v.subarray(0, n), o)
    o += n
    if (n < v.length) seq.rest = v.subarray(n)
  }
  seq.pos += o
  return out.subarray(0, o)
}

/**
 * A URL read by byte range. A server that ignores Range (answers 200 with
 * the whole file) is remembered: its stream stays open and later chunks are
 * read on from it, so the file is not downloaded again for every chunk.
 */
export function urlSource(url: string, knownSize: number | null = null): ChunkSource {
  let seq: SequentialStream | null = null
  let ignoresRange = false
  const dropStream = () => {
    if (seq) void seq.reader.cancel().catch(() => {})
    seq = null
  }
  const readSequential = async (offset: number, length: number) => {
    const open = seq
    if (!open) return new Uint8Array(0)
    try {
      // Skip to the offset (only the first read of a fresh stream skips).
      while (open.pos < offset) {
        const skipped = await readOn(open, Math.min(offset - open.pos, CHUNK_SIZE))
        if (skipped.length === 0) return new Uint8Array(0)
      }
      return await readOn(open, length)
    } catch (e) {
      dropStream()
      throw e
    }
  }
  const src: ChunkSource = {
    size: knownSize,
    async read(offset, length, signal) {
      if (ignoresRange && seq && seq.pos === offset) return readSequential(offset, length)
      dropStream()
      const res = await fetch(url, {
        signal,
        ...(ignoresRange ? {} : { headers: { Range: `bytes=${offset}-${offset + length - 1}` } }),
      })
      if (!res.ok || !res.body) return new Uint8Array(0)
      const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]
      if (total) src.size = Number(total)
      else if (res.status === 200) {
        const len = Number(res.headers.get('content-length'))
        if (len > 0) src.size = len
      }
      if (res.status === 206) return takeRange(res.body.getReader(), 0, length)
      ignoresRange = true
      seq = { reader: res.body.getReader(), pos: 0, rest: null }
      return readSequential(offset, length)
    },
  }
  return src
}

/** Skip `skip` bytes of a stream, then collect at most `length`. */
export async function takeRange(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  skip: number,
  length: number
): Promise<Uint8Array> {
  const out = new Uint8Array(length)
  let pos = 0
  let o = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    let v = value
    if (pos + v.length <= skip) {
      pos += v.length
      continue
    }
    if (pos < skip) {
      v = v.subarray(skip - pos)
      pos = skip
    }
    const n = Math.min(v.length, length - o)
    out.set(v.subarray(0, n), o)
    o += n
    pos += n
    if (o >= length) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return out.subarray(0, o)
}

/** A NUL in the first bytes, or a high share of control bytes. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF)
  let ctl = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 0) return true
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) ctl++
  }
  return n > 0 && ctl / n > 0.1
}

export interface LineState {
  lines: string[]
  /** The unfinished last line, waiting for the next chunk. */
  tail: string
}

export function createLineState(): LineState {
  return { lines: [], tail: '' }
}

/**
 * Cut a chunk into lines, appending in place (the array can be large; it is
 * never copied). With `final`, the tail becomes the last line.
 */
export function pushText(state: LineState, text: string, final: boolean): void {
  let start = 0
  const s = state.tail + text
  state.tail = ''
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', start)) {
    const end = i > start && s.charCodeAt(i - 1) === 13 ? i - 1 : i
    state.lines.push(s.slice(start, end))
    start = i + 1
  }
  const rest = s.slice(start)
  if (final) {
    if (rest.length) state.lines.push(rest.endsWith('\r') ? rest.slice(0, -1) : rest)
  } else state.tail = rest
}

export interface ChunkReader {
  /** Units read so far. */
  readonly loaded: number
  readonly size: number | null
  readonly done: boolean
  readonly binary: boolean
  readonly state: LineState
  /** Read the next chunk and cut it into lines. */
  next(signal?: AbortSignal): Promise<void>
}

/** Sequential reader over a source; UTF-8 split across chunks is kept intact. */
export function createChunkReader(src: ChunkSource, chunk = CHUNK_SIZE): ChunkReader {
  const decoder = new TextDecoder()
  const state = createLineState()
  let loaded = 0
  let done = false
  let binary = false
  let inflight: Promise<void> | null = null
  return {
    get loaded() {
      return loaded
    },
    get size() {
      return src.size
    },
    get done() {
      return done
    },
    get binary() {
      return binary
    },
    state,
    // One read at a time: two overlapping calls read the same offset and
    // pushed the chunk twice (LIBB-010).
    next(signal) {
      if (!inflight) {
        inflight = readNext(signal).finally(() => {
          inflight = null
        })
      }
      return inflight
    },
  }

  async function readNext(signal?: AbortSignal): Promise<void> {
    if (done) return
    const part = await src.read(loaded, chunk, signal)
    if (signal?.aborted) return
    if (typeof part !== 'string' && loaded === 0 && looksBinary(part)) {
      binary = true
      done = true
      return
    }
    loaded += part.length
    // A known size decides the end: servers may answer a range with less
    // than asked (Tauri's asset protocol caps one response near 1 MB), and
    // a short read there is not the end of the file. Without a size only an
    // empty read is the end. In-memory text never comes back short.
    done =
      part.length === 0 ||
      (src.size !== null ? loaded >= src.size : typeof part === 'string' && part.length < chunk)
    const text =
      typeof part === 'string' ? part : decoder.decode(part, { stream: !done })
    pushText(state, text, done)
  }
}

// ── windowing ───────────────────────────────────────────────────────────────

/**
 * Top offset of every line plus the total height at the end. Without wrap
 * (`cols` = Infinity) every line is one row; with wrap a line takes as many
 * rows as its display length needs. Lines past LINE_CAP count as capped
 * unless expanded.
 */
export function rowOffsets(
  lines: readonly string[],
  rowHeight: number,
  cols: number,
  expanded?: ReadonlySet<number>
): Float64Array {
  const out = new Float64Array(lines.length + 1)
  let y = 0
  for (let i = 0; i < lines.length; i++) {
    out[i] = y
    let rows = 1
    if (Number.isFinite(cols) && cols > 0) {
      const len =
        expanded?.has(i) || lines[i].length <= LINE_CAP ? lines[i].length : LINE_CAP + 1
      rows = Math.max(1, Math.ceil(len / cols))
    }
    y += rows * rowHeight
  }
  out[lines.length] = y
  return out
}

/** First and one-past-last line to render for a scroll position. */
export function visibleWindow(
  offsets: Float64Array,
  scrollTop: number,
  viewport: number,
  overscan = 20
): { start: number; end: number } {
  const n = offsets.length - 1
  if (n <= 0) return { start: 0, end: 0 }
  const find = (y: number) => {
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (offsets[mid] <= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const first = find(Math.max(0, scrollTop))
  const last = find(scrollTop + viewport)
  return { start: Math.max(0, first - overscan), end: Math.min(n, last + 1 + overscan) }
}

/** Display form of a line: capped unless expanded. */
export function capLine(line: string, expanded: boolean): { text: string; cut: boolean } {
  if (expanded || line.length <= LINE_CAP) return { text: line, cut: false }
  return { text: line.slice(0, LINE_CAP), cut: true }
}
