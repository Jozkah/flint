/**
 * The tools a room participant may use during its turn.
 *
 * File tools (read/ls/find/grep) read the room's attached folder; with `edit`
 * access, write/edit are added too, confined to that folder by a direct-edit
 * grant (the gate refuses any write outside the grant's root). Web tools
 * (web_search/web_fetch) research the web and need no folder. MCP tools come
 * from the user's connected Model Context Protocol servers, but only from
 * servers the backend actually trusts ("always allow" a server once in chat) --
 * rooms never prompt, so an untrusted server's tools are withheld rather than
 * refused mid-call. The renderer "allow all MCP" toggle does not grant backend
 * trust, so it is intentionally not honoured here. Disabled tools are dropped
 * too.
 * Each tool carries an `execute`, so the AI SDK runs the tool cycle itself.
 * Schemas for the built-ins come from Rust via `getAgentToolSchemas`, the same
 * source Cowork uses, so a room advertises the identical contract.
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

/** Cap on captured tool output kept for the transcript's advanced view. */
export const ROOM_TOOL_OUTPUT_CAP = 4000

/** Keep the transcript small: truncate captured output past the cap. */
function capOutput(text: string): string {
  return text.length > ROOM_TOOL_OUTPUT_CAP
    ? `${text.slice(0, ROOM_TOOL_OUTPUT_CAP)}\n… (truncated)`
    : text
}

type ExecOptions = { readOnlyProject?: string; writeGrant?: string; scope: 'thread' }

export async function buildRoomTools(
  ctx: RoomToolContext,
  onActivity?: (a: RoomToolActivity) => void
): Promise<Record<string, Tool>> {
  const tools: Record<string, Tool> = {}

  const run = (name: string, options: ExecOptions) => async (input: unknown) => {
    const result = await executeAgentTool(name, input, ctx.roomId, options)
    const output = result.error ? `ERROR: ${result.error}` : (result.content ?? '')
    onActivity?.({ name, ok: !result.error, args: input, output: capOutput(output) })
    return output
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
  let report: { trusted: Array<{ name: string; fingerprint: string; currentFingerprint: string | null }> }
  try {
    mcp = getServiceHub().mcp()
    // The backend's own trust record is the source of truth: exactly the
    // servers whose calls it will allow. Advertising by anything else risks
    // offering a tool that is then refused mid-turn (rooms never prompt).
    ;[mcpTools, report] = await Promise.all([
      mcp.getTools(),
      mcp.trustReport().catch(() => ({ trusted: [], invalidated: [] })),
    ])
  } catch {
    return out
  }

  const isDisabled = useToolAvailable.getState().isToolDisabled
  // Advertise a server's tools only when the backend actually trusts its CURRENT
  // definition. A grant whose fingerprint no longer matches (the server's config
  // changed) would be refused mid-call, so require the running definition to be
  // the approved one. The renderer's "allow all MCP" toggle is deliberately NOT
  // honoured -- it does not write backend trust. Trust a server via "Always
  // allow" in chat and it appears in rooms and works.
  const trustedSet = new Set(
    report.trusted
      .filter((e) => e.currentFingerprint != null && e.currentFingerprint === e.fingerprint)
      .map((e) => e.name)
  )
  const serverTrusted = (server: string) => trustedSet.has(server)
  for (const t of mcpTools) {
    if (isDisabled(t.server, t.name)) continue
    if (!serverTrusted(t.server)) continue // withhold untrusted servers, never refuse mid-call
    if (out[t.name]) continue // first server wins on a name clash, like the chat
    out[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      execute: async (input: unknown) => {
        try {
          // Route to the exact server the tool was advertised from, so a bare
          // name shared by another server cannot redirect the call.
          const res = await mcp.callTool({
            toolName: t.name,
            serverName: t.server,
            arguments: input as object,
          })
          const output = res.error
            ? `ERROR: ${res.error}`
            : (res.content ?? []).map((c) => c.text).join('\n')
          onActivity?.({ name: t.name, ok: !res.error, args: input, output: capOutput(output), mcp: true })
          return output
        } catch (e) {
          const output = `ERROR: ${e instanceof Error ? e.message : String(e)}`
          onActivity?.({ name: t.name, ok: false, args: input, output, mcp: true })
          return output
        }
      },
    } as Tool
  }
  return out
}
