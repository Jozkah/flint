/**
 * The read-only tools a room participant may use during its turn.
 *
 * File tools (read/ls/find/grep) read the room's attached folder; web tools
 * (web_search/web_fetch) research the web and need no folder. Each carries an
 * `execute`, so the AI SDK runs the tool cycle itself: a read needs no
 * permission prompt (the gate allows a read inside the folder, and the web
 * tools only fetch), so there is nothing for the room to intercept. Schemas for
 * the file tools come from Rust via `getAgentToolSchemas`, the same source
 * Cowork uses, so a room advertises the identical contract.
 */
import { jsonSchema, type Tool } from 'ai'
import { getAgentToolSchemas, executeAgentTool } from '@/lib/agentTools'
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

/** Upper bound on tool steps in one participant turn, so a turn cannot loop. */
export const ROOM_TOOL_MAX_STEPS = 8

export async function buildRoomTools(
  ctx: RoomToolContext,
  onActivity?: (a: RoomToolActivity) => void
): Promise<Record<string, Tool>> {
  const tools: Record<string, Tool> = {}

  // One execute for every room tool: run it keyed to the room, read-only
  // against the folder when there is one, and report the call for the
  // transcript.
  const run = (name: string) => async (input: unknown) => {
    const result = await executeAgentTool(
      name,
      input,
      ctx.roomId,
      ctx.folder
        ? { readOnlyProject: ctx.folder, scope: 'thread' }
        : { scope: 'thread' }
    )
    onActivity?.({ name, ok: !result.error })
    return result.error ? `ERROR: ${result.error}` : (result.content ?? '')
  }

  // File tools only make sense against an attached folder.
  if (ctx.folder) {
    const schemas = await getAgentToolSchemas(ctx.folder, undefined, 'thread')
    const allow = new Set<string>(ROOM_READ_TOOLS)
    for (const s of schemas) {
      const name = s.function.name
      if (!allow.has(name)) continue
      tools[name] = {
        description: s.function.description,
        inputSchema: jsonSchema(s.function.parameters as Record<string, unknown>),
        execute: run(name),
      } as Tool
    }
  }

  // Web research when the app has web search on -- no folder required, so a
  // participant can look things up even in a room with no folder attached.
  if (useWebSearchConfig.getState().webSearchEnabled) {
    tools['web_search'] = {
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: jsonSchema(WEB_SEARCH_INPUT_SCHEMA as Record<string, unknown>),
      execute: run('web_search'),
    } as Tool
    tools['web_fetch'] = {
      description: WEB_FETCH_DESCRIPTION,
      inputSchema: jsonSchema(WEB_FETCH_INPUT_SCHEMA as Record<string, unknown>),
      execute: run('web_fetch'),
    } as Tool
  }

  return tools
}
