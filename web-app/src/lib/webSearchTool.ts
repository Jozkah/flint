import { webSearch, webFetch } from '@janhq/tauri-plugin-websearch-api'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'

export const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])

/**
 * Whether a call named `web_search` / `web_fetch` is Jan's own native web tool.
 *
 * Only while built-in web search is on. With it off, Jan does not advertise the
 * native tools, so a call by that name came from an MCP server that exposes one
 * -- and it must get that server's approval prompt and run on that server. The
 * name alone used to decide, so an MCP server's `web_search` skipped approval
 * and was sent to Jan's native adapter instead (janhq/jan#8777).
 */
export function isNativeWebTool(toolName: string): boolean {
  return (
    WEB_TOOL_NAMES.has(toolName) &&
    useWebSearchConfig.getState().webSearchEnabled
  )
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

export const WEB_FETCH_DESCRIPTION =
  'Fetch a web page by URL and return its readable text content along with the source URL and title. Output is bounded to avoid flooding the context. Use after web_search to read a specific result.'

export const WEB_FETCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The http(s) URL to fetch.' },
  },
  required: ['url'],
} as const

type WebToolInput = { query?: unknown; count?: unknown; url?: unknown }
type WebToolResult = { content?: unknown; error?: string }

/**
 * Execute a native web tool via the websearch plugin and shape web_search
 * output into the web-citation payload consumed by parseCitationsFromToolOutput.
 */
export async function executeWebTool(
  toolName: string,
  input: WebToolInput
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
    if (toolName === 'web_fetch') {
      const url = typeof input?.url === 'string' ? input.url : ''
      const page = await webFetch(url, apiKey, searchProvider, endpoint)
      const text = `Title: ${page.title}\nURL: ${page.url}\n\n${page.content}${
        page.truncated ? '\n\n[content truncated]' : ''
      }`
      return { content: text }
    }
    return { error: `Unknown web tool '${toolName}'` }
  } catch (e) {
    const message =
      e && typeof e === 'object' && 'message' in e
        ? String((e as { message: unknown }).message)
        : String(e)
    return { error: message }
  }
}
