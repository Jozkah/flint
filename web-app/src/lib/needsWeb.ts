/**
 * Whether a message asks for something only the web can give: a link to open,
 * or an explicit request to search or look something up online.
 *
 * Used to offer turning web search on before sending, rather than letting the
 * model answer that it has no web tools. Deliberately narrow: a false positive
 * interrupts a send, so plain mentions of "search" in code talk do not count.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i
const ASK_RE =
  /(^|[.!?]\s+|\b(?:please|can you|could you|pls)\s+)(?:search|google|look up|browse)\b|\b(?:search|look (?:it|this|that) up) (?:online|the web|the internet)\b|\b(?:open|read|check|fetch|visit) (?:this|that|the) (?:link|url|page|site|website)\b/i

export function needsWeb(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return URL_RE.test(t) || ASK_RE.test(t)
}
