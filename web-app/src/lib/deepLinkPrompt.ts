/** Longest prefill accepted from a link; a link is not a place for a document. */
export const MAX_DEEP_LINK_PROMPT = 4000

const HOSTS = new Set(['chat', 'prompt', 'new'])

/**
 * The text a `flint://chat?prompt=...` link (or legacy `jan://`) asks the
 * composer to start with, or null when the link carries none.
 *
 * The text only fills the composer: the user reads it and sends it themselves.
 * A link comes from outside the app, so control characters are dropped, the
 * length is capped and an empty value is ignored.
 */
export function promptFromDeepLink(link: string): string | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== 'flint:' && url.protocol !== 'jan:') return null
  if (!HOSTS.has(url.hostname)) return null
  const raw = url.searchParams.get('prompt')
  if (raw === null) return null
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const text = cleaned.replace(/\r\n?/g, '\n').trim().slice(0, MAX_DEEP_LINK_PROMPT)
  return text.length > 0 ? text : null
}
