/**
 * Small, bounded previews of an attached file's first bytes. Everything here
 * is best effort: a failure returns null and the caller shows the kind icon.
 * No dependency: a minimal zip reader over the platform DecompressionStream.
 */

export const TEXT_CAP = 64 * 1024
export const ZIP_CAP = 2 * 1024 * 1024
const ENTRY_CAP = 1024 * 1024

export type FilePreview =
  | { kind: 'text'; lines: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'doc'; paragraphs: string[] }

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'log', 'js', 'jsx', 'ts', 'tsx', 'py', 'rs',
  'go', 'java', 'c', 'cpp', 'h', 'cs', 'yaml', 'yml', 'toml', 'html', 'css',
  'sh', 'ps1', 'sql', 'xml', 'ini', 'cfg', 'env',
])

export function previewKind(
  ext: string
): 'text' | 'table' | 'docx' | 'xlsx' | 'pptx' | null {
  const e = ext.toLowerCase()
  if (e === 'csv' || e === 'tsv') return 'table'
  if (e === 'docx') return 'docx'
  if (e === 'xlsx') return 'xlsx'
  if (e === 'pptx') return 'pptx'
  if (TEXT_EXT.has(e)) return 'text'
  return null
}

export function textPreview(
  text: string,
  maxLines = 8,
  maxCols = 120
): FilePreview | null {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(0, maxLines)
    .map((l) => (l.length > maxCols ? l.slice(0, maxCols) + '…' : l))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.length ? { kind: 'text', lines } : null
}

export function csvPreview(
  text: string,
  delimiter: ',' | '\t' = ',',
  maxRows = 6,
  maxCols = 5
): FilePreview | null {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const pushCell = () => {
    row.push(cell.length > 40 ? cell.slice(0, 40) + '…' : cell)
    cell = ''
  }
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) pushCell()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      pushCell()
      rows.push(row.slice(0, maxCols))
      row = []
    } else cell += ch
  }
  if (rows.length < maxRows && (cell || row.length)) {
    pushCell()
    rows.push(row.slice(0, maxCols))
  }
  return rows.length ? { kind: 'table', rows } : null
}

// ── zip ─────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string
  method: number
  csize: number
  offset: number
}

function listZip(b: Uint8Array): ZipEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out: ZipEntry[] = []
  const dec = new TextDecoder()
  for (let n = 0; n < count && n < 5000; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nlen = dv.getUint16(p + 28, true)
    const elen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const offset = dv.getUint32(p + 42, true)
    out.push({
      name: dec.decode(b.subarray(p + 46, p + 46 + nlen)),
      method,
      csize,
      offset,
    })
    p += 46 + nlen + elen + clen
  }
  return out
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(data)
      c.close()
    },
  })
  const reader = source
    .pipeThrough(
      new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >
    )
    .getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total > ENTRY_CAP) {
      await reader.cancel()
      break
    }
  }
  const out = new Uint8Array(Math.min(total, ENTRY_CAP))
  let o = 0
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - o)
    if (n <= 0) break
    out.set(c.subarray(0, n), o)
    o += n
  }
  return out
}

async function readEntry(b: Uint8Array, e: ZipEntry): Promise<string | null> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (e.offset + 30 > b.length || dv.getUint32(e.offset, true) !== 0x04034b50)
    return null
  const nlen = dv.getUint16(e.offset + 26, true)
  const elen = dv.getUint16(e.offset + 28, true)
  const start = e.offset + 30 + nlen + elen
  const raw = b.subarray(start, start + e.csize)
  let bytes: Uint8Array | null
  if (e.method === 0) bytes = raw.subarray(0, ENTRY_CAP)
  else if (e.method === 8) bytes = await inflateRaw(raw)
  else bytes = null
  return bytes ? new TextDecoder().decode(bytes) : null
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function textRuns(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g')
  let out = ''
  for (let m = re.exec(xml); m; m = re.exec(xml)) out += unescapeXml(m[1])
  return out
}

function paragraphsOf(
  xml: string,
  para: RegExp,
  tag: string,
  max: number
): string[] {
  const out: string[] = []
  for (let m = para.exec(xml); m && out.length < max; m = para.exec(xml)) {
    const t = textRuns(m[0], tag).trim()
    if (t) out.push(t.length > 200 ? t.slice(0, 200) + '…' : t)
  }
  return out
}

/** First paragraphs of a .docx (word/document.xml). */
export async function docxPreview(
  b: Uint8Array,
  maxParas = 6
): Promise<FilePreview | null> {
  const entry = listZip(b).find((e) => e.name === 'word/document.xml')
  if (!entry) return null
  const xml = await readEntry(b, entry)
  if (!xml) return null
  const paragraphs = paragraphsOf(xml, /<w:p[ >][\s\S]*?<\/w:p>/g, 'w:t', maxParas)
  return paragraphs.length ? { kind: 'doc', paragraphs } : null
}

/** First slide text of a .pptx. */
export async function pptxPreview(
  b: Uint8Array,
  maxParas = 6
): Promise<FilePreview | null> {
  const entries = listZip(b)
  const slide =
    entries.find((e) => e.name === 'ppt/slides/slide1.xml') ??
    entries.find((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
  if (!slide) return null
  const xml = await readEntry(b, slide)
  if (!xml) return null
  const paragraphs = paragraphsOf(xml, /<a:p[ >][\s\S]*?<\/a:p>/g, 'a:t', maxParas)
  return paragraphs.length ? { kind: 'doc', paragraphs } : null
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** First rows/columns of the first sheet of an .xlsx. */
export async function xlsxPreview(
  b: Uint8Array,
  maxRows = 6,
  maxCols = 5
): Promise<FilePreview | null> {
  const entries = listZip(b)
  const sheet =
    entries.find((e) => e.name === 'xl/worksheets/sheet1.xml') ??
    entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
  if (!sheet) return null
  const strings: string[] = []
  const sst = entries.find((e) => e.name === 'xl/sharedStrings.xml')
  if (sst) {
    const xml = await readEntry(b, sst)
    if (xml) {
      const re = /<si>([\s\S]*?)<\/si>/g
      for (let m = re.exec(xml); m && strings.length < 2000; m = re.exec(xml))
        strings.push(textRuns(m[1], 't'))
    }
  }
  const xml = await readEntry(b, sheet)
  if (!xml) return null
  const rows: string[][] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  for (let r = rowRe.exec(xml); r && rows.length < maxRows; r = rowRe.exec(xml)) {
    const cells: string[] = []
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    for (let c = cellRe.exec(r[1]); c; c = cellRe.exec(r[1])) {
      const attrs = c[1]
      const idx = colIndex(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? 'A1')
      if (idx >= maxCols) continue
      const inner = c[2] ?? ''
      let v: string
      if (/\bt="s"/.test(attrs)) {
        v = strings[Number(/<v>(\d+)<\/v>/.exec(inner)?.[1])] ?? ''
      } else if (/\bt="inlineStr"/.test(attrs)) {
        v = textRuns(inner, 't')
      } else v = unescapeXml(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '')
      cells[idx] = v.length > 40 ? v.slice(0, 40) + '…' : v
    }
    rows.push(Array.from(cells, (x) => x ?? ''))
  }
  return rows.length ? { kind: 'table', rows } : null
}

// ── byte source ─────────────────────────────────────────────────────────────

/** Read at most `cap` bytes of a URL; with `strict`, null when it is larger. */
export async function readCapped(
  url: string,
  cap: number,
  signal: AbortSignal,
  strict = false
): Promise<Uint8Array | null> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total > cap) {
      await reader.cancel()
      if (strict) return null
      break
    }
  }
  const out = new Uint8Array(Math.min(total, cap))
  let o = 0
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - o)
    if (n <= 0) break
    out.set(c.subarray(0, n), o)
    o += n
  }
  return out
}

/** Build the preview for a file's bytes, by extension. Never throws. */
export async function previewFromBytes(
  ext: string,
  bytes: Uint8Array
): Promise<FilePreview | null> {
  try {
    const kind = previewKind(ext)
    if (kind === 'docx') return await docxPreview(bytes)
    if (kind === 'xlsx') return await xlsxPreview(bytes)
    if (kind === 'pptx') return await pptxPreview(bytes)
    const text = new TextDecoder().decode(bytes.subarray(0, TEXT_CAP))
    if (kind === 'table')
      return csvPreview(text, ext.toLowerCase() === 'tsv' ? '\t' : ',')
    if (kind === 'text') return textPreview(text)
    return null
  } catch {
    return null
  }
}
