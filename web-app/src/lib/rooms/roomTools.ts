/**
 * The tools a room participant may use during its turn.
 *
 * File tools (read/ls/find/grep) read the room's attached folder; with `edit`
 * access, write/edit are added too, confined to that folder by a direct-edit
 * grant (the gate refuses any write outside the grant's root). Web tools
 * (web_search/web_fetch) research the web and need no folder. MCP tools come
 * from the user's connected Model Context Protocol servers -- the same set the
 * main chat exposes, filtered by the global per-tool disable list. Each tool
 * carries an `execute`, so the AI SDK runs the tool cycle itself. Schemas for
 * the built-ins come from Rust via `getAgentToolSchemas`, the same source
 * Cowork uses, so a room advertises the identical contract.
 */
import { jsonSchema, type Tool } from 'ai'
import { directEditAuthorize } from '@janhq/tauri-plugin-agent-tools-api'
import { getAgentToolSchemas, executeAgentTool } from '@/lib/agentTools'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import {
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_INPUT_SCHEMA,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_INPUT_SCHEMA,
} from '@/lib/webSearchTool'
import type { RoomToolActivity, RoomToolContext } from './callError'

/** The read-only built-in file tools a room participant may use. */
export const ROOM_READ_TOOLS = ['read', 'ls', 'find', 'grep'] as const
/** The write tools added for `edit` access, confined to the folder by a grant. */
export const ROOM_WRITE_TOOLS = ['write', 'edit'] as const

/** Upper bound on tool steps in one participant turn, so a turn cannot loop. */
export const ROOM_TOOL_MAX_STEPS = 8

type ExecOptions = { readOnlyProject?: string; writeGrant?: string; scope: 'thread' }

export async function buildRoomTools(
  ctx: RoomToolContext,
  onActivity?: (a: RoomToolActivity) => void
): Promise<Record<string, Tool>> {
  const tools: Record<string, Tool> = {}

  const run = (name: string, options: ExecOptions) => async (input: unknown) => {
    const result = await executeAgentTool(name, input, ctx.roomId, options)
    onActivity?.({ name, ok: !result.error })
    return result.error ? `ERROR: ${result.error}` : (result.content ?? '')
  }

  // File tools only make sense against an attached folder. With `edit` access,
  // mint a write grant confined to that folder so write/edit can be offered.
  if (ctx.folder) {
    let writeGrant: string | undefined
    if (ctx.access === 'edit') {
      try {
        const dataFolder = await getServiceHub().app().getJanDataFolder()
        if (dataFolder) {
          writeGrant = await directEditAuthorize(dataFolder, ctx.roomId, ctx.folder)
        }
      } catch {
        // No grant -> no write tools; reads still work.
      }
    }
    const readOptions: ExecOptions = { readOnlyProject: ctx.folder, scope: 'thread' }
    const writeOptions: ExecOptions | undefined = writeGrant
      ? { readOnlyProject: ctx.folder, writeGrant, scope: 'thread' }
      : undefined

    const allow = new Set<string>(ROOM_READ_TOOLS)
    if (writeOptions) for (const w of ROOM_WRITE_TOOLS) allow.add(w)
    const isWrite = (name: string) => (ROOM_WRITE_TOOLS as readonly string[]).includes(name)

    const schemas = await getAgentToolSchemas(ctx.folder, undefined, 'thread')
    for (const s of schemas) {
      const name = s.function.name
      if (!allow.has(name)) continue
      const options = isWrite(name) ? writeOptions! : readOptions
      tools[name] = {
        description: s.function.description,
        inputSchema: jsonSchema(s.function.parameters as Record<string, unknown>),
        execute: run(name, options),
      } as Tool
    }
  }

  // Web research when the app has web search on -- no folder required.
  if (useWebSearchConfig.getState().webSearchEnabled) {
    const webOptions: ExecOptions = { scope: 'thread' }
    tools['web_search'] = {
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: jsonSchema(WEB_SEARCH_INPUT_SCHEMA as Record<string, unknown>),
      execute: run('web_search', webOptions),
    } as Tool
    tools['web_fetch'] = {
      description: WEB_FETCH_DESCRIPTION,
      inputSchema: jsonSchema(WEB_FETCH_INPUT_SCHEMA as Record<string, unknown>),
      execute: run('web_fetch', webOptions),
    } as Tool
  }

  // MCP tools from the user's connected servers -- no folder required. Same set
  // the main chat exposes, minus the globally disabled ones. A built-in tool of
  // the same name wins (already added above), so MCP never shadows file tools.
  const mcpTools = await buildMcpTools(onActivity)
  for (const [name, tool] of Object.entries(mcpTools)) {
    if (!tools[name]) tools[name] = tool
  }

  return tools
}

/**
 * Advertise the connected MCP servers' tools, keyed by bare tool name (as the
 * main chat does), dropping any the user disabled in the global tool list. Each
 * call routes through `mcp().callTool`; the text content is returned to the
 * model and an error surfaces as `ERROR: ...`, matching the built-in tools.
 */
export async function buildMcpTools(
  onActivity?: (a: RoomToolActivity) => void
): Promise<Record<string, Tool>> {
  const out: Record<string, Tool> = {}
  let mcp: ReturnType<ReturnType<typeof getServiceHub>['mcp']>
  let mcpTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; server: string }>
  try {
    mcp = getServiceHub().mcp()
    mcpTools = await mcp.getTools()
  } catch {
    return out
  }

  const isDisabled = useToolAvailable.getState().isToolDisabled
  for (const t of mcpTools) {
    if (isDisabled(t.server, t.name)) continue
    if (out[t.name]) continue // first server wins on a name clash, like the chat
    out[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      execute: async (input: unknown) => {
        try {
          const res = await mcp.callTool({ toolName: t.name, arguments: input as object })
          onActivity?.({ name: t.name, ok: !res.error })
          if (res.error) return `ERROR: ${res.error}`
          return (res.content ?? []).map((c) => c.text).join('\n')
        } catch (e) {
          onActivity?.({ name: t.name, ok: false })
          return `ERROR: ${e instanceof Error ? e.message : String(e)}`
        }
      },
    } as Tool
  }
  return out
}
