/**
 * Where a tool call came from. Flint runs four families of tools -- the native
 * web tools, the built-in RAG tools, the built-in agent tools, and MCP server
 * tools -- and a collapsed card is ambiguous without saying which.
 */
export type ToolOrigin =
  | { kind: 'web-search'; detail: string }
  | { kind: 'web-fetch' }
  | { kind: 'rag' }
  | { kind: 'agent' }
  | { kind: 'mcp'; detail: string }

export type ToolOriginContext = {
  /** MCP server owning this tool, when it is an MCP tool. */
  mcpServer?: string
  isRagTool: boolean
  isAgentTool: boolean
  /** Display name of the configured web search provider, e.g. "Exa". */
  webSearchProviderLabel: string
  /**
   * Whether Flint's own web tools are on. Off, a `web_search` / `web_fetch`
   * call came from an MCP server exposing that name, and is credited to it.
   */
  nativeWebEnabled?: boolean
}

export const WEB_SEARCH_TOOL = 'web_search'
export const WEB_FETCH_TOOL = 'web_fetch'

/**
 * Resolution order mirrors the execution order in the thread route: native web
 * tools win (unless they are off and an MCP server owns the name), then agent
 * tools, then RAG, then MCP. RAG names shadowed by an MCP
 * server are already dropped from the RAG set upstream, so the two cannot both
 * match.
 */
export function resolveToolOrigin(
  toolName: string,
  {
    mcpServer,
    isRagTool,
    isAgentTool,
    webSearchProviderLabel,
    nativeWebEnabled = true,
  }: ToolOriginContext
): ToolOrigin | undefined {
  const webName = toolName === WEB_SEARCH_TOOL || toolName === WEB_FETCH_TOOL
  if (webName && mcpServer && !nativeWebEnabled) {
    return { kind: 'mcp', detail: mcpServer }
  }
  if (toolName === WEB_SEARCH_TOOL) {
    return { kind: 'web-search', detail: webSearchProviderLabel }
  }
  if (toolName === WEB_FETCH_TOOL) return { kind: 'web-fetch' }
  if (isAgentTool) return { kind: 'agent' }
  if (isRagTool) return { kind: 'rag' }
  if (mcpServer) return { kind: 'mcp', detail: mcpServer }
  return undefined
}
