import type { WebCitation } from '@/components/Citations'

/**
 * The URL a `web_fetch` result read, or null when it read nothing.
 *
 * The tool's text starts `Title: ...\nURL: <url>`; an error does not. The
 * output may arrive as the string or wrapped in JSON, so the URL stops at
 * whitespace, a quote or a backslash (an escaped newline).
 */
export function fetchedUrlOf(output: unknown): string | null {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  const match = /URL: (https?:\/\/[^\s"\\]+)/.exec(text)
  return match ? match[1] : null
}

export type WebSourceSummary = {
  /** Every distinct source, pages read first. */
  sources: WebCitation[]
  /** Pages actually fetched and read. */
  read: number
  /** Search hits that were not read. */
  found: number
}

/**
 * Separate the pages a reply read from the search hits it only saw, so the
 * badge does not call twenty search results "sources" when four were read.
 */
export function summarizeWebSources(
  citations: WebCitation[],
  readUrls: string[]
): WebSourceSummary {
  const readSet = new Set(readUrls)
  const byUrl = new Map(citations.map((c) => [c.url, c]))
  const sources: WebCitation[] = []
  for (const url of readSet) sources.push(byUrl.get(url) ?? { url })
  const seen = new Set(readSet)
  for (const c of citations) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    sources.push(c)
  }
  return { sources, read: readSet.size, found: sources.length - readSet.size }
}
