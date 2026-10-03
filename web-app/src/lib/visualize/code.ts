/**
 * Preparing a model's `widget_code` for display. Pure string work, so the card,
 * the tool and the tests agree on what a widget is.
 */

const FENCE = /^```[a-z]*\s*\n?|\n?```\s*$/gi
// Wrappers a fragment does not need, and tags that act on the whole document
// (a meta refresh would navigate the frame; <base> would redirect every URL).
const WRAPPER_TAGS =
  /<\/?(?:html|head|body)\b[^>]*>|<!doctype[^>]*>|<meta\b[^>]*>|<base\b[^>]*>|<link\b[^>]*>/gi

/** The fragment itself: fences, document wrappers and document-level tags removed. */
export function normalizeWidgetCode(raw: string): string {
  return raw.replace(FENCE, '').replace(WRAPPER_TAGS, '').trim()
}

/**
 * The part of a half-written widget that is safe to paint, or null while there
 * is nothing worth showing. It stops at the last complete tag, drops an
 * unfinished <script>/<style>/comment, and needs at least one whole element.
 * Scripts never run from this: partial markup is set as inert HTML, and only
 * the finished widget is activated.
 */
export function partialMarkup(raw: string): string | null {
  let s = normalizeWidgetCode(raw)
  const cutUnclosed = (open: RegExp, close: string) => {
    let at = -1
    for (const m of s.matchAll(open)) at = m.index ?? at
    if (at >= 0 && !s.toLowerCase().includes(close, at)) s = s.slice(0, at)
  }
  cutUnclosed(/<script\b/gi, '</script')
  cutUnclosed(/<style\b/gi, '</style')
  const comment = s.lastIndexOf('<!--')
  if (comment >= 0 && !s.includes('-->', comment)) s = s.slice(0, comment)
  const lt = s.lastIndexOf('<')
  if (lt > s.lastIndexOf('>')) s = s.slice(0, lt)
  s = s.trimEnd()
  return s.length >= 20 && /<[a-z][^>]*>/i.test(s) ? s : null
}

/** A readable one-line name for a widget whose title is missing. */
export function widgetFallbackTitle(code: string): string {
  const heading = /<h[1-3][^>]*>([^<]{2,80})</i.exec(code)
  return heading ? heading[1].trim() : 'Widget'
}

/** One JSON string value read from possibly unfinished JSON text. */
function partialJsonString(text: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text)
  if (!m) return undefined
  let out = ''
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const c = text[i]
    if (c === '"') return out
    if (c !== '\\') {
      out += c
      continue
    }
    const n = text[i + 1]
    if (n === undefined) return out
    if (n === 'u') {
      const hex = text.slice(i + 2, i + 6)
      if (hex.length < 4) return out
      out += String.fromCharCode(parseInt(hex, 16) || 0)
      i += 5
      continue
    }
    out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
    i++
  }
  return out
}

/**
 * The `show_widget` arguments read so far from the streamed JSON text, for
 * runners that get argument deltas as raw text rather than a parsed object.
 */
export function partialWidgetArgs(jsonText: string): {
  title?: string
  widget_code?: string
  loading_messages?: string[]
} {
  const loading: string[] = []
  const block = /"loading_messages"\s*:\s*\[([^\]]*)\]/.exec(jsonText)
  if (block) {
    for (const s of block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) loading.push(s[1])
  }
  return {
    title: partialJsonString(jsonText, 'title'),
    widget_code: partialJsonString(jsonText, 'widget_code'),
    ...(loading.length ? { loading_messages: loading } : {}),
  }
}
