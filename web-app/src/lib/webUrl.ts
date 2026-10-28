/** Display host for a URL, e.g. "https://www.rust-lang.org/x" -> "rust-lang.org". */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * A reply as copied text: each model-emitted `[[cite:URL]]` marker (drawn as a
 * chip in chat) becomes a plain " (URL)" after the statement it backs.
 */
export const citationsForCopy = (text: string): string =>
  text.includes('[[cite:')
    ? text.replace(/\s*\[\[cite:\s*([^\]\s]+?)\s*\]\]/g, (_m, url: string) =>
        ` (${/^https?:\/\//i.test(url) ? url : `https://${url}`})`
      )
    : text

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

/** Dotted-quad IPv4 (the URL parser normalises hex, octal and decimal forms to it). */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const privateV4 = (a: number, b: number): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT / tailnet
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168)

/**
 * A host that is not on the public internet: asking it for an icon would tell
 * a LAN or loopback service (and whoever watches the network) which page the
 * model just read, and probes services that were never meant to be fetched.
 * Judged on the host as the URL parser normalised it; a public name that
 * resolves to a private address is not caught here.
 */
export const isNonPublicHost = (hostname: string): boolean => {
  let h = hostname.toLowerCase().replace(/\.$/, '')
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (!h) return true
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true
    const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mapped) {
      const hi = parseInt(mapped[1], 16)
      return privateV4(hi >> 8, hi & 255)
    }
    const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (dotted) return isNonPublicHost(dotted[1])
    // fc00::/7 unique local, fe80::/10 link local.
    return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
  }
  const v4 = h.match(IPV4)
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]))
  if (!h.includes('.')) return true // a bare name resolves on the local network
  return /\.(localhost|local|internal|lan|localdomain|home\.arpa|intranet|corp)$/.test(h)
}

export const faviconCandidates = (url: string): string[] => {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return []
    if (isNonPublicHost(u.hostname)) return []
    return FAVICON_PATHS.map((p) => `${u.origin}${p}`)
  } catch {
    return []
  }
}

export const faviconUrl = (url: string): string | null => {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (isNonPublicHost(u.hostname)) return null
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
