/**
 * Tools left out of a plain chat on a small context window.
 *
 * Every offered tool's schema rides on every request. On a 32K local model the
 * six default tools cost about 1K tokens before the user typed anything, and
 * these four are the ones a small model rarely needs: the plugin listing,
 * image search, and the two widget tools. Web search and fetch, MCP and the
 * agent tools stay. The setting lives in Settings > Agent tools (on by default).
 */
export const SMALL_WINDOW_TOKENS = 32_768

export const LOW_VALUE_TOOLS: ReadonlySet<string> = new Set([
  'list_plugins',
  'image_search',
  'visualize_read_me',
  'show_widget',
])

export function toolsForWindow<T>(
  tools: Record<string, T>,
  windowTokens: number,
  lean: boolean
): Record<string, T> {
  if (!lean || !(windowTokens > 0) || windowTokens > SMALL_WINDOW_TOKENS) return tools
  if (!Object.keys(tools).some((name) => LOW_VALUE_TOOLS.has(name))) return tools
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !LOW_VALUE_TOOLS.has(name))
  )
}
