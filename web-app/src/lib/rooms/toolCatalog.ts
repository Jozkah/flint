/**
 * What tools a room participant gets, for the editor's Tools section: the
 * built-in file tools its access allows, web search/fetch when the app has web
 * search on, widgets, skills, and the tools of MCP servers the backend trusts.
 * Each is sized as its schema is sent, so the editor can show what the tool
 * list costs of the model's window. The engine applies the same rules (see
 * `roomTools.ts` / `fullTools.ts`); this only lists them.
 */
import { estimateToolTokens } from '@/lib/context-manager'
import type { ToolAccess } from './types'

/** The read-only built-in file tools a room participant may use. */
export const ROOM_READ_TOOLS = ['read', 'ls', 'find', 'grep'] as const
/** The write tools added for `edit` access, confined to the folder by a grant. */
export const ROOM_WRITE_TOOLS = ['write', 'edit'] as const

/**
 * Tools a room participant never gets, even at full access: they belong to a
 * Cowork session (its todo list, subagents, mail to other sessions) or write
 * state the room has no owner for (memory, new skills), or ask for folders the
 * room's editor already decided.
 */
export const WITHHELD = new Set([
  'request_access',
  'skill_write',
  'list_sessions',
  'send_message',
  'read_messages',
  'wait_for_reply',
  'stop_session',
  'message_send',
  'message_check',
])
export const withheld = (name: string) => WITHHELD.has(name) || name.startsWith('memory_')

/** Share of the model's window past which the tool list is flagged. */
export const TOOL_WINDOW_WARN_SHARE = 0.15

export type ToolGroup = 'files' | 'web' | 'mcp' | 'other'
export type ToolCatalogEntry = {
  name: string
  group: ToolGroup
  tokens: number
  server?: string
  /**
   * A configured, trusted MCP server that is not running: its tools are not
   * known until it starts (at the participant's first turn, by the lazy
   * start), so it is one switch for the whole server, `name` = `mcpServerKey`.
   */
  notStarted?: boolean
}

/** The `disabledTools` entry that switches a whole MCP server off. */
export const mcpServerKey = (server: string) => `mcp:${server}`

/** The servers a participant's `disabledTools` switches off as a whole. */
export function disabledMcpServers(disabled: readonly string[] | undefined): Set<string> {
  return new Set((disabled ?? []).filter((n) => n.startsWith('mcp:')).map((n) => n.slice(4)))
}

/** The built-in folder tools an access level gets, in the given order. */
export function accessToolNames(names: readonly string[], access: ToolAccess): string[] {
  if (access === 'none') return []
  if (access === 'full') return names.filter((n) => !withheld(n))
  const allow = new Set<string>(ROOM_READ_TOOLS)
  if (access === 'edit') for (const w of ROOM_WRITE_TOOLS) allow.add(w)
  return names.filter((n) => allow.has(n))
}

export function summarizeToolTokens(
  entries: readonly ToolCatalogEntry[],
  disabled: readonly string[] | undefined,
  window: number
): { enabledTokens: number; enabledCount: number; share: number; warn: boolean } {
  const off = new Set(disabled ?? [])
  const on = entries.filter((e) => !off.has(e.name))
  const enabledTokens = on.reduce((t, e) => t + e.tokens, 0)
  const share = window > 0 ? enabledTokens / window : 0
  return { enabledTokens, enabledCount: on.length, share, warn: window > 0 && share > TOOL_WINDOW_WARN_SHARE }
}

/**
 * The tools a participant with `access` would get in a room with `folder`.
 * Reads only: starts no MCP server and mints no write grant.
 */
export async function loadRoomToolCatalog(
  folder: string | null,
  access: ToolAccess
): Promise<ToolCatalogEntry[]> {
  if (access === 'none') return []
  const out: ToolCatalogEntry[] = []
  const add = (name: string, group: ToolGroup, schema: unknown, server?: string) => {
    if (out.some((e) => e.name === name)) return
    out.push({ name, group, tokens: estimateToolTokens(name, schema), ...(server ? { server } : {}) })
  }
  if (folder) {
    try {
      const { getAgentToolSchemas } = await import('@/lib/agentTools')
      const schemas = await getAgentToolSchemas(folder, undefined, 'thread')
      const allowed = new Set(accessToolNames(schemas.map((s) => s.function.name), access))
      for (const s of schemas) {
        if (!allowed.has(s.function.name)) continue
        add(s.function.name, 'files', { description: s.function.description, inputSchema: s.function.parameters })
      }
    } catch {
      // No schemas: the list shows what else is offered.
    }
  }
  try {
    const { useWebSearchConfig } = await import('@/hooks/useWebSearchConfig')
    if (useWebSearchConfig.getState().webSearchEnabled) {
      const web = await import('@/lib/webSearchTool')
      add('web_search', 'web', { description: web.WEB_SEARCH_DESCRIPTION, inputSchema: web.WEB_SEARCH_INPUT_SCHEMA })
      add('web_fetch', 'web', { description: web.WEB_FETCH_DESCRIPTION, inputSchema: web.WEB_FETCH_INPUT_SCHEMA })
    }
  } catch {
    // No web tools.
  }
  try {
    const { useVisualizeConfig } = await import('@/hooks/useVisualizeConfig')
    if (useVisualizeConfig.getState().enabled) {
      const { visualizeSchemas } = await import('@/lib/visualize/tools')
      for (const s of visualizeSchemas()) {
        add(s.function.name, 'other', { description: s.function.description, inputSchema: s.function.parameters })
      }
    }
  } catch {
    // No widgets.
  }
  add('skill_read', 'other', { description: "Read a skill's full instructions by name." })
  try {
    const { getServiceHub } = await import('@/hooks/useServiceHub')
    const { useToolAvailable } = await import('@/hooks/useToolAvailable')
    const mcp = getServiceHub().mcp()
    const [tools, report] = await Promise.all([
      mcp.getTools(),
      mcp.trustReport().catch(() => ({ trusted: [] as Array<{ name: string; fingerprint: string; currentFingerprint: string | null }> })),
    ])
    const trusted = new Set(
      report.trusted
        .filter((e) => e.currentFingerprint != null && e.currentFingerprint === e.fingerprint)
        .map((e) => e.name)
    )
    const isDisabled = useToolAvailable.getState().isToolDisabled
    const listed = new Set<string>()
    for (const t of tools ?? []) {
      listed.add(t.server)
      if (!trusted.has(t.server) || isDisabled(t.server, t.name)) continue
      add(t.name, 'mcp', { description: t.description, inputSchema: t.inputSchema }, t.server)
    }
    // Configured, enabled and trusted, but not started: listed by name so the
    // user can switch it, without starting it (the plain listing above never
    // starts a server, and neither does reading the config).
    const config = await mcp.getMCPConfig().catch(() => null)
    for (const [server, def] of Object.entries(config?.mcpServers ?? {})) {
      if (def?.active === false || listed.has(server) || !trusted.has(server)) continue
      if (out.some((e) => e.name === mcpServerKey(server))) continue
      out.push({ name: mcpServerKey(server), group: 'mcp', tokens: 0, server, notStarted: true })
    }
  } catch {
    // No MCP tools.
  }
  return out
}
