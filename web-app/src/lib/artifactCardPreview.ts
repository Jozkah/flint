/**
 * Small text previews for Library cards: the first few KB of a file, read once
 * and cached by URL, so a card shows real content without loading the whole
 * file (or reading it again on every render).
 */

/** How much of a file a card preview reads. */
export const CARD_PREVIEW_BYTES = 4096
/** How many lines a card shows at most. */
export const CARD_PREVIEW_LINES = 12

const cache = new Map<string, Promise<string | null>>()

/** Reads up to `CARD_PREVIEW_BYTES` of `url` as text; null when unreadable. */
export function loadPreviewText(url: string): Promise<string | null> {
  const hit = cache.get(url)
  if (hit) return hit
  const job = readHead(url).catch(() => null)
  cache.set(url, job)
  return job
}

/** Drops cached previews (tests; a file rewritten under the same path). */
export function clearPreviewCache() {
  cache.clear()
}

async function readHead(url: string): Promise<string | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  const reader = res.body?.getReader?.()
  if (!reader) return (await res.text()).slice(0, CARD_PREVIEW_BYTES)
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < CARD_PREVIEW_BYTES) {
    const { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    total += value.length
  }
  void reader.cancel().catch(() => {})
  const bytes = new Uint8Array(Math.min(total, CARD_PREVIEW_BYTES))
  let at = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - at)
    bytes.set(part, at)
    at += part.length
    if (at >= bytes.length) break
  }
  // A cut in the middle of a multi-byte character decodes to U+FFFD; fine.
  return new TextDecoder().decode(bytes)
}

export type PreviewLine = { text: string; heading?: boolean }

/**
 * Markdown as plain lines: headings flagged, list/quote/emphasis/link syntax
 * dropped, fences and blank runs removed. Not a renderer, just enough for a
 * glance at a card.
 */
export function markdownLines(source: string): PreviewLine[] {
  const out: PreviewLine[] = []
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^\s*(```|~~~|---+\s*$|<!--)/.test(line)) continue
    if (!line.trim()) continue
    const heading = /^\s{0,3}#{1,6}\s+/.test(line)
    const text = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, '• ')
      .replace(/^\s*>\s?/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2')
    out.push({ text, heading })
    if (out.length >= CARD_PREVIEW_LINES) break
  }
  return out
}

/** Plain text or code: the first non-empty lines, as written. */
export function textLines(source: string): PreviewLine[] {
  return source
    .split(/\r?\n/)
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()))
    .slice(0, CARD_PREVIEW_LINES)
    .map((text) => ({ text }))
}

/** An HTML page's title and first readable text, scripts and styles removed. */
export function htmlLines(source: string): PreviewLine[] {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1]?.trim()
  const body = source
    .replace(/<(script|style|head|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h\d|li|tr|section|header|br)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
  const lines = body
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((l) => l !== title)
    .slice(0, CARD_PREVIEW_LINES - 1)
    .map((text) => ({ text }))
  return title ? [{ text: title, heading: true }, ...lines] : lines
}

/** "3:07" for an audio length in seconds. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
