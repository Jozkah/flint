// Highlighted-markup cache for the read-only code viewer.
//
// Its own module rather than a constant inside the component: the viewer is a
// component file, and exporting helpers beside it breaks fast refresh.

/**
 * Keyed by the content itself plus theme and language.
 *
 * Switching tabs back and forth re-mounts the viewer, and re-tokenising bytes
 * that have not changed is pure waste. The content is part of the key rather
 * than a path-and-size stand-in: two files of equal length would otherwise
 * collide and each render the other's markup, and a file the agent rewrites
 * would keep serving its old highlighting.
 */
const MAX_ENTRIES = 40

const cache = new Map<string, string>()

export function highlightKey(
  content: string,
  lang: string,
  theme: string
): string {
  return `${theme} ${lang} ${content}`
}

export function readHighlight(key: string): string | undefined {
  return cache.get(key)
}

/** Bounded by insertion order, so a session that opens hundreds of files does
 * not hold every one of them. */
export function rememberHighlight(key: string, markup: string): void {
  cache.set(key, markup)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** Drop everything. For tests, which assert on how often highlighting runs. */
export function clearHighlightCache(): void {
  cache.clear()
}
