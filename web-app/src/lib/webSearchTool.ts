import { webSearch, webFetch, imageSearch } from '@janhq/tauri-plugin-websearch-api'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'

export const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch', 'image_search'])

/**
 * Whether a call named `web_search` / `web_fetch` is Flint's own native web tool.
 *
 * Only while built-in web search is on. With it off, Flint does not advertise the
 * native tools, so a call by that name came from an MCP server that exposes one
 * -- and it must get that server's approval prompt and run on that server. The
 * name alone used to decide, so an MCP server's `web_search` skipped approval
 * and was sent to Flint's native adapter instead (janhq/jan#8777).
 *
 * `advertised` is the run's own tool set, not the global setting: a Settings
 * toggle applies at the next run, so a run that started with web search on keeps
 * its native tools for the rest of the run, and a run that started with it off
 * keeps routing `web_search` to an MCP server even if the setting is turned on
 * mid-run.
 */
export function isNativeWebTool(
  toolName: string,
  advertised?: Record<string, unknown>
): boolean {
  if (!WEB_TOOL_NAMES.has(toolName)) return false
  if (advertised !== undefined) return 'web_search' in advertised
  return useWebSearchConfig.getState().webSearchEnabled
}

export const WEB_SEARCH_DESCRIPTION =
  'Search the web and return a ranked list of results (title, URL, snippet, and optional publish date). Use this to find current information, documentation, or sources you can then read with web_fetch. Cite the URLs you rely on.'

export const WEB_SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The search query.' },
    count: {
      type: 'integer',
      description: 'Maximum number of results to return (default 5, max 20).',
    },
  },
  required: ['query'],
} as const

export const IMAGE_SEARCH_DESCRIPTION =
  'Find images for a query (covers, products, places). Returns image URLs and their source pages. Show one with ![alt](image URL) only when it helps.'

export const IMAGE_SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to find, e.g. "Ugly Love book cover".' },
    count: { type: 'integer', description: 'Max images (default 5).' },
  },
  required: ['query'],
} as const

export const WEB_FETCH_DESCRIPTION =
  'Fetch a web page by URL and return its readable text content along with the source URL and title. Output is bounded to avoid flooding the context. Use after web_search to read a specific result.'

export const WEB_FETCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The http(s) URL to fetch.' },
    offset: {
      type: 'integer',
      description:
        'Character offset to start reading from, to continue a page that was cut off (default 0).',
    },
  },
  required: ['url'],
} as const

type WebToolInput = {
  query?: unknown
  count?: unknown
  url?: unknown
  offset?: unknown
}

/** Most page text one web_fetch call returns, in characters. */
export const WEB_FETCH_MAX_CHARS = 12_000

/**
 * How long a failed fetch of a URL is remembered. A model that just saw a
 * URL fail tends to fetch the very same URL again straight away (the audit
 * saw three archive.org retries in one turn); inside this window it gets the
 * earlier error back instead of another network round trip.
 */
export const WEB_FETCH_FAILURE_TTL_MS = 2 * 60_000

const failedFetches = new Map<string, { error: string; at: number }>()

/** Forget remembered fetch failures (tests). */
export function resetWebFetchFailures(): void {
  failedFetches.clear()
}

/**
 * One window of a fetched page's text: at most WEB_FETCH_MAX_CHARS from
 * `offset`, with a note saying how much is left and how to read on.
 */
export function pageWindow(
  content: string,
  offset: number,
  maxChars: number = WEB_FETCH_MAX_CHARS
): string {
  const start = Math.min(Math.max(0, Math.floor(offset)), content.length)
  const end = Math.min(content.length, start + maxChars)
  const slice = content.slice(start, end)
  const more = content.length - end
  if (more <= 0) return slice
  return `${slice}\n\n[truncated, ${more} chars more -- call web_fetch again with offset ${end} to read on]`
}
type WebToolResult = { content?: unknown; error?: string }

/**
 * Execute a native web tool via the websearch plugin and shape web_search
 * output into the web-citation payload consumed by parseCitationsFromToolOutput.
 */
export async function executeWebTool(
  toolName: string,
  input: WebToolInput,
  /** Char budget one result may occupy for this model (deriveToolOutputCap). */
  maxOutputChars?: number
): Promise<WebToolResult> {
  const { apiKeys, endpoints, searchProvider } = useWebSearchConfig.getState()
  const apiKey = apiKeys[searchProvider] || undefined
  const endpoint = endpoints[searchProvider] || undefined
  try {
    if (toolName === 'web_search') {
      const query = typeof input?.query === 'string' ? input.query : ''
      const count = typeof input?.count === 'number' ? input.count : undefined
      const results = await webSearch(query, count, apiKey, searchProvider, endpoint)
      return {
        content: {
          kind: 'web',
          query,
          results: results.map((r) => ({
            url: r.url,
            title: r.title,
            text: r.snippet,
            published_date: r.published_at,
          })),
        },
      }
    }
    if (toolName === 'image_search') {
      const query = typeof input?.query === 'string' ? input.query : ''
      const count = typeof input?.count === 'number' ? input.count : undefined
      const images = await imageSearch(query, count, apiKey, searchProvider, endpoint)
      if (images.length === 0) {
        return { content: `No images found for "${query}". Answer without one.` }
      }
      return {
        content: images
          .map((img, i) => {
            const alt = img.title.replace(/[[\]\s]+/g, ' ').trim() || query
            return `${i + 1}. ${alt}\n   image: ${img.image_url}\n   page: ${img.source_url}`
          })
          .join('\n'),
      }
    }
    if (toolName === 'web_fetch') {
      const url = typeof input?.url === 'string' ? input.url : ''
      const offset = typeof input?.offset === 'number' ? input.offset : 0
      const key = url.trim()
      const failed = failedFetches.get(key)
      if (failed && Date.now() - failed.at < WEB_FETCH_FAILURE_TTL_MS) {
        return {
          error: `${failed.error} (this URL already failed moments ago; not fetched again -- try a different source)`,
        }
      }
      let page: Awaited<ReturnType<typeof webFetch>>
      try {
        page = await webFetch(url, apiKey, searchProvider, endpoint)
      } catch (e) {
        // A provider rate limit says nothing about the URL: the backend's own
        // gate already refuses calls until the cool-down ends, and a retry
        // after it must reach the network, so it is not remembered here.
        if (!isRateLimited(e)) {
          failedFetches.set(key, { error: messageOf(e), at: Date.now() })
        }
        throw e
      }
      failedFetches.delete(key)
      // A small window cannot take a full page window: scale it down, with a
      // floor so a tiny cap still returns something readable.
      const windowChars =
        typeof maxOutputChars === 'number' && maxOutputChars > 0
          ? Math.min(WEB_FETCH_MAX_CHARS, Math.max(1_000, maxOutputChars))
          : WEB_FETCH_MAX_CHARS
      const body = pageWindow(page.content ?? '', offset, windowChars)
      const text = `Title: ${page.title}\nURL: ${page.url}\n\n${body}${
        page.truncated ? '\n\n[content truncated at the source]' : ''
      }`
      return { content: text }
    }
    return { error: `Unknown web tool '${toolName}'` }
  } catch (e) {
    return { error: messageOf(e) }
  }
}

/** Whether the websearch plugin rejected with its rate-limit kind. */
function isRateLimited(e: unknown): boolean {
  return (
    !!e &&
    typeof e === 'object' &&
    'kind' in e &&
    (e as { kind: unknown }).kind === 'rate_limited'
  )
}

function messageOf(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e)
}
