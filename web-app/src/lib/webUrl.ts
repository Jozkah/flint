/** Display host for a URL, e.g. "https://www.rust-lang.org/x" -> "rust-lang.org". */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * The letter shown in place of a site's icon.
 *
 * Flint used to fetch favicons from Google, which meant every domain a search
 * returned — and therefore a good deal about what someone was reading — was
 * reported to a third party none of this app talks to otherwise. A letter
 * drawn from the hostname fills the same slot and leaves the machine.
 */
export const siteInitial = (url: string): string => {
  const labels = hostOf(url).split('.').filter(Boolean)
  // The site's own name, not a subdomain: `docs.`, `learn.` and `developer.`
  // front half the web, and turned every chip into the same letter.
  let name = labels.length >= 2 ? labels[labels.length - 2] : (labels[0] ?? '')
  if (labels.length >= 3 && SECOND_LEVEL.has(name)) {
    name = labels[labels.length - 3]
  }
  const letter = name.replace(/^[^a-z0-9]+/i, '')[0]
  return letter && /[a-z0-9]/i.test(letter) ? letter.toUpperCase() : '?'
}

/** Registry labels under a country code (`example.co.uk`), never the site. */
const SECOND_LEVEL: ReadonlySet<string> = new Set([
  'co',
  'com',
  'org',
  'net',
  'ac',
  'gov',
  'edu',
])

/**
 * The site's own favicon, fetched from the site itself (never a third-party
 * favicon service, which would see every domain a search returned). Null for
 * anything that is not http(s).
 */
/**
 * The addresses a site's icon is tried at, in order, all on its own origin.
 * `/favicon.ico` is the convention, but many sites serve an SVG or PNG instead.
 */
export const FAVICON_PATHS = [
  '/favicon.ico',
  '/favicon.svg',
  '/favicon.png',
  '/apple-touch-icon.png',
] as const

export const faviconCandidates = (url: string): string[] => {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return []
    return FAVICON_PATHS.map((p) => `${u.origin}${p}`)
  } catch {
    return []
  }
}

export const faviconUrl = (url: string): string | null => {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin}/favicon.ico`
  } catch {
    return null
  }
}

/** True only for absolute http(s) URLs; anything else is not safe to link. */
export const isHttpUrl = (url: string): boolean => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * The URL inside a `#webcite-<encoded url>` href, or null when the payload is
 * malformed (bad percent-encoding) or not http(s).
 */
export const decodeWebCiteHref = (href: string): string | null => {
  try {
    const url = decodeURIComponent(href.slice('#webcite-'.length))
    return isHttpUrl(url) ? url : null
  } catch {
    return null
  }
}
