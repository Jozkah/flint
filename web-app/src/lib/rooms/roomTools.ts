/**
 * The read-only built-in tools a room participant may use during its turn.
 *
 * Unlike Cowork's manual tool loop, these carry an `execute`, so the AI SDK
 * runs the tool cycle itself: a read tool needs no permission prompt (the gate
 * allows a read inside the attached folder), so there is nothing for the room to
 * intercept. Schemas come from Rust via `getAgentToolSchemas`, the same source
 * Cowork uses, so a room advertises the identical contract for these tools.
 */
import { jsonSchema, type Tool } from 'ai'
import { getAgentToolSchemas, executeAgentTool } from '@/lib/agentTools'
import type { RoomToolActivity, RoomToolContext } from './callError'

/** The read-only built-in tools a room participant may use. */
export const ROOM_READ_TOOLS = ['read', 'ls', 'find', 'grep'] as const

/** Upper bound on tool steps in one participant turn, so a turn cannot loop. */
export const ROOM_TOOL_MAX_STEPS = 8

export async function buildRoomTools(
  ctx: RoomToolContext,
  onActivity?: (a: RoomToolActivity) => void
): Promise<Record<string, Tool>> {
  const schemas = await getAgentToolSchemas(ctx.folder, undefined, 'thread')
  const allow = new Set<string>(ROOM_READ_TOOLS)
  const tools: Record<string, Tool> = {}
  for (const s of schemas) {
    const name = s.function.name
    if (!allow.has(name)) continue
    tools[name] = {
      description: s.function.description,
      inputSchema: jsonSchema(s.function.parameters as Record<string, unknown>),
      execute: async (input: unknown) => {
        // Keyed to the room so the sandbox workspace is the room's own; the
        // folder is the read-only root the read resolves against.
        const result = await executeAgentTool(name, input, ctx.roomId, {
          readOnlyProject: ctx.folder,
          scope: 'thread',
        })
        onActivity?.({ name, ok: !result.error })
        return result.error ? `ERROR: ${result.error}` : (result.content ?? '')
      },
    } as Tool
  }
  return tools
}
