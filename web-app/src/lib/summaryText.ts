/**
 * A model-written summary without its scaffolding. The summary prompt asks for
 * `<analysis>` then `<summary>`; reasoning models add `<think>`; small models
 * drop a tag or leave one unclosed. Whatever comes back, only the summary
 * itself is stored, sent or shown (M-033: raw `<analysis>` leaked into a
 * mention's summary block).
 */
const SCRATCH = /<(analysis|think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi
const STRAY = /<\/?(?:analysis|summary|think|thinking|reasoning)\b[^>]*>/gi

export function stripSummaryScaffolding(raw: string): string {
  const text = raw ?? ''
  const inner = /<summary\b[^>]*>([\s\S]*?)(?:<\/summary\s*>|$)/i.exec(text)
  // A closing tag with no opener: what precedes it was the analysis.
  const closedOnly = /<\/analysis\s*>/i.exec(text)
  let body = inner
    ? inner[1]
    : closedOnly && !/<analysis\b/i.test(text)
      ? text.slice(closedOnly.index + closedOnly[0].length)
      : text
  body = body.replace(SCRATCH, '').replace(STRAY, '')
  return body.trim()
}
