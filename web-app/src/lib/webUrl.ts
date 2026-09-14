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
  const host = hostOf(url)
  return (host.replace(/^[^a-z0-9]+/i, '')[0] ?? '?').toUpperCase()
}
