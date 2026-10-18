/**
 * Search snippets are cut out of raw message Markdown, so they carry `**`,
 * list markers and fences. This turns one into a short run of styled text
 * spans (never HTML: the caller builds React text nodes from them) and marks
 * where the query matched, across span boundaries.
 */

export type SnippetStyle = {
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  link?: boolean
}

export type SnippetSpan = SnippetStyle & { text: string }
export type RichSnippetPart = SnippetSpan & { match: boolean }

const MENTION_BLOCK = /<conversation-mention\b[^>]*>[\s\S]*?<\/conversation-mention>/g
const HTML_TAG = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g

/** Line structure flattened to one line: bullets become ' · ', headings bold. */
export function flattenSnippet(raw: string): string {
  const text = (raw ?? '').replace(MENTION_BLOCK, ' ').replace(HTML_TAG, '')
  const lines = text.split(/\r?\n/).map((line) => {
    let l = line.trim()
    l = l.replace(/^(?:>\s?)+/, '')
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(l)
    if (heading) return heading[1] ? `**${heading[1]}**` : ''
    // A fence line: keep its language-less body as code by leaving the
    // backticks; drop the language tag.
    l = l.replace(/^(`{3,}|~{3,})[\w+-]*\s*$/, (_m, f: string) => (f[0] === '`' ? f : ''))
    if (/^[-*+]\s+\S/.test(l)) return `\u0000${l.replace(/^[-*+]\s+/, '')}`
    return l
  })
  let out = ''
  for (const l of lines) {
    if (!l) continue
    if (l.startsWith('\u0000')) {
      out += (out ? ' · ' : '') + l.slice(1)
    } else {
      out += (out ? ' ' : '') + l
    }
  }
  // Snippets from the search backend already lost their newlines: a lone
  // `*` or `+` between spaces is a list marker there, never emphasis; so is
  // one opening the snippet (or right after its leading ellipsis).
  out = out
    // A marker the snippet window cut right after: `Sydney. ##…`.
    .replace(/\s+(?:#{1,6}|[-*+])\s*(?=…?$)/, '')
    .replace(/^(…?)\s*[-*+]\s+(?=\S)/, '$1')
    .replace(/\s+[*+]\s+(?=\S)/g, ' · ')
    .replace(/(^|\s)#{1,6}\s+(?=\S)/g, '$1')
  return out.replace(/\s+/g, ' ').trim()
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)

function push(out: SnippetSpan[], text: string, style: SnippetStyle) {
  if (!text) return
  const prev = out[out.length - 1]
  if (
    prev &&
    !!prev.bold === !!style.bold &&
    !!prev.italic === !!style.italic &&
    !!prev.code === !!style.code &&
    !!prev.strike === !!style.strike &&
    !!prev.link === !!style.link
  ) {
    prev.text += text
    return
  }
  out.push({ ...cleanStyle(style), text })
}

function cleanStyle(style: SnippetStyle): SnippetStyle {
  const s: SnippetStyle = {}
  if (style.bold) s.bold = true
  if (style.italic) s.italic = true
  if (style.code) s.code = true
  if (style.strike) s.strike = true
  if (style.link) s.link = true
  return s
}

/** Index of a closing `marker` for one opened at `from`, or -1. */
function findClose(text: string, marker: string, from: number): number {
  let i = from
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') {
      // Skip code spans: emphasis does not close inside one.
      const run = /^`+/.exec(text.slice(i))![0]
      const end = text.indexOf(run, i + run.length)
      if (end !== -1) {
        i = end + run.length
        continue
      }
    }
    if (text.startsWith(marker, i)) {
      const before = text[i - 1]
      const after = text[i + marker.length]
      const single = marker.length === 1
      const flanking = before !== undefined && before !== ' '
      const notDoubled = !single || text[i + 1] !== marker && before !== marker
      const intraword = marker[0] === '_' && isWordChar(after)
      if (flanking && notDoubled && !intraword && i > from) return i
    }
    i++
  }
  return -1
}

function tokenize(text: string, style: SnippetStyle, out: SnippetSpan[]) {
  let i = 0
  let plain = ''
  const flush = () => {
    push(out, plain, style)
    plain = ''
  }
  while (i < text.length) {
    const c = text[i]
    const rest = text.slice(i)
    if (c === '\\' && i + 1 < text.length && /[\\`*_~[\]()#+\-.!<>|]/.test(text[i + 1])) {
      plain += text[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      const run = /^`+/.exec(rest)![0]
      const end = text.indexOf(run, i + run.length)
      flush()
      if (end === -1) {
        // An unclosed fence or span (the snippet was cut): the rest is code.
        if (run.length >= 3 || text.endsWith('…')) {
          const tail = text.slice(i + run.length).trim()
          const cut = tail.endsWith('…')
          push(out, cut ? tail.slice(0, -1) : tail, { ...style, code: true })
          if (cut) push(out, '…', style)
          return
        }
        plain += run
        i += run.length
        continue
      }
      const body = text.slice(i + run.length, end).trim()
      push(out, body, { ...style, code: true })
      i = end + run.length
      continue
    }
    if (c === '!' && text[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\([^)\s]*(?:\s[^)]*)?\)/.exec(rest)
      if (m) {
        flush()
        tokenize(m[1], style, out)
        i += m[0].length
        continue
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\([^)\s]*(?:\s[^)]*)?\)/.exec(rest)
      if (m) {
        flush()
        tokenize(m[1], { ...style, link: true }, out)
        i += m[0].length
        continue
      }
    }
    const double = rest.startsWith('**') ? '**' : rest.startsWith('__') ? '__' : rest.startsWith('~~') ? '~~' : null
    if (double) {
      const opensWord = double !== '__' || !isWordChar(text[i - 1])
      const end = opensWord && text[i + 2] !== ' ' ? findClose(text, double, i + 2) : -1
      if (end !== -1) {
        flush()
        const inner = double === '~~' ? { ...style, strike: true } : { ...style, bold: true }
        tokenize(text.slice(i + 2, end), inner, out)
        i = end + 2
        continue
      }
      // A doubled marker with no partner was cut off by the snippet window:
      // drop it rather than show syntax.
      i += 2
      continue
    }
    if (c === '*' || c === '_') {
      const opens =
        text[i + 1] !== undefined &&
        text[i + 1] !== ' ' &&
        (c === '*' || !isWordChar(text[i - 1]))
      const end = opens ? findClose(text, c, i + 1) : -1
      if (end !== -1) {
        flush()
        tokenize(text.slice(i + 1, end), { ...style, italic: true }, out)
        i = end + 1
        continue
      }
    }
    plain += c
    i++
  }
  flush()
}

/** The styled spans of a raw Markdown snippet, on one line. */
export function snippetSpans(raw: string): SnippetSpan[] {
  const out: SnippetSpan[] = []
  tokenize(flattenSnippet(raw), {}, out)
  return out
}

/**
 * The snippet's spans, split where the query (case-insensitive, literal)
 * matches the text as displayed, so a match inside bold or code, or one
 * spanning a style change, is still marked.
 */
export function richSnippet(raw: string, query: string): RichSnippetPart[] {
  const spans = snippetSpans(raw)
  const full = spans.map((s) => s.text).join('')
  const q = query.trim().toLowerCase()
  const ranges: [number, number][] = []
  if (q) {
    const hay = full.toLowerCase()
    // Lowercasing can change length for a few scripts; fall back to no marks.
    if (hay.length === full.length) {
      let from = 0
      for (;;) {
        const at = hay.indexOf(q, from)
        if (at === -1) break
        ranges.push([at, at + q.length])
        from = at + q.length
      }
    }
  }
  const parts: RichSnippetPart[] = []
  let offset = 0
  for (const span of spans) {
    const start = offset
    const end = offset + span.text.length
    offset = end
    let cut = start
    const style = cleanStyle(span)
    for (const [a, b] of ranges) {
      if (b <= cut || a >= end) continue
      const s = Math.max(a, cut)
      const e = Math.min(b, end)
      if (s > cut) parts.push({ ...style, text: full.slice(cut, s), match: false })
      parts.push({ ...style, text: full.slice(s, e), match: true })
      cut = e
    }
    if (cut < end) parts.push({ ...style, text: full.slice(cut, end), match: false })
  }
  return parts
}
