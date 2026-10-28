/**
 * Text helpers of the campaign runner: verdict parsing, clipping and the
 * model id split. Split out of the runner (campaignRunner.ts).
 */

/** Reasoning blocks removed, as the backend does before it reads a verdict. */
export function stripReasoning(text: string): string {
  let out = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
  const close = out.toLowerCase().lastIndexOf('</think>')
  if (close >= 0) out = out.slice(close + '</think>'.length)
  else {
    const open = out.toLowerCase().indexOf('<think>')
    if (open >= 0) out = out.slice(0, open)
  }
  return out
}

/** The verdict a reply carries, anywhere in it; the last occurrence wins. */
export function findVerdict(text: string): string | null {
  const flat = stripReasoning(text).replace(/[*`#]/g, '')
  const re =
    /verdict["']?\s*(?:(?:[:=\-–—]|\bis\b)\s*)?["'[(]?\s*(pass|partial|fail|blocked)\b/gi
  let found: string | null = null
  for (const m of flat.matchAll(re)) found = m[1].toUpperCase()
  return found
}

/** At most 300 characters of what the model said. */
export function excerptOf(text: string): string {
  const cleaned = stripReasoning(text).trim() ? stripReasoning(text) : text
  const flat = cleaned.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

export const VERDICT_REMINDER =
  'Your reply had no verdict line. Reply again with the first line exactly ' +
  '`VERDICT: PASS`, `VERDICT: PARTIAL`, `VERDICT: FAIL` or `VERDICT: BLOCKED`, ' +
  'then `EVIDENCE:` and a short justification. No thinking, no markdown, no JSON.'

export const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}...` : s

export function parseModel(
  raw: string
): { provider: string; id: string } | undefined {
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) }
}
