/**
 * The tools a room participant may use during its turn.
 *
 * File tools (read/ls/find/grep) read the room's attached folder; with `edit`
 * access, write/edit are added too, confined to that folder by a direct-edit
 * grant (the gate refuses any write outside the grant's root). Web tools
 * (web_search/web_fetch) research the web and need no folder. Each tool carries
 * an `execute`, so the AI SDK runs the tool cycle itself. Schemas for the
 * built-ins come from Rust via `getAgentToolSchemas`, the same source Cowork
 * uses, so a room advertises the identical contract.
 */
import { jsonSchema, type Tool } from 'ai'
import { directEditAuthorize } from '@janhq/tauri-plugin-agent-tools-api'
import { getAgentToolSchemas, executeAgentTool } from '@/lib/agentTools'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
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

  return tools
}
