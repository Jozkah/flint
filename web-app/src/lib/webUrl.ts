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
