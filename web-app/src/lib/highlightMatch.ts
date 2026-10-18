export type HighlightPart = { text: string; match: boolean }

/**
 * Split `text` around every case-insensitive, literal occurrence of `query`
 * (regex characters are plain text), keeping the original casing. A query
 * that is empty or not found gives the whole text as one unmatched part.
 */
export function splitByMatch(text: string, query: string): HighlightPart[] {
  const q = query.trim()
  if (!q || !text) return [{ text, match: false }]
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const parts: HighlightPart[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue
    const at = m.index ?? 0
    if (at > last) parts.push({ text: text.slice(last, at), match: false })
    parts.push({ text: m[0], match: true })
    last = at + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false })
  return parts.length ? parts : [{ text, match: false }]
}
