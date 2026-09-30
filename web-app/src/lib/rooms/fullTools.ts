import { jsonSchema, type Tool } from 'ai'
import { directEditAuthorize } from '@janhq/tauri-plugin-agent-tools-api'
import { getAgentToolSchemas } from '@/lib/agentTools'
import { dispatchCoworkTool, type DispatchContext } from '@/lib/coworkDispatch'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { getServiceHub } from '@/hooks/useServiceHub'
import type { RoomToolActivity, RoomToolContext } from './callError'

/** Output kept for the transcript's advanced view, as for the other tools. */
const OUTPUT_CAP = 4000

/**
 * Tools a room participant never gets, even at full access: they belong to a
 * Cowork session (its todo list, subagents, mail to other sessions) or write
 * state the room has no owner for (memory, new skills), or ask for folders the
 * room's editor already decided.
 */
const WITHHELD = new Set([
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
const withheld = (name: string) => WITHHELD.has(name) || name.startsWith('memory_')

const refused = (what: string) => async () => ({
  output: `${what} is not available in a room.`,
  isError: true,
})

/**
 * The folder tools of a participant who works like a Cowork agent: shell, git,
 * file tools, skills and plugins, all through the Cowork dispatcher, so the
 * same permission policy applies.
 *
 * The room runs in Cowork's "ask" mode: a call that changes something or runs
 * a command waits for the user to allow it, through the same approval prompt,
 * with the same saved rules and the same pause after a long streak of
 * auto-approved calls. Anything the prompt cannot reach is refused.
 */
export async function buildFullFolderTools(
  ctx: RoomToolContext,
  onActivity?: (a: RoomToolActivity) => void
): Promise<Record<string, Tool>> {
  const folder = ctx.folder
  if (!folder) return {}
  const extras = ctx.extraFolders ?? []

  // A write grant for the attached folders, so a call the user allows can write.
  // Without one the participant still reads and runs sandboxed commands.
  let writeGrant: string | undefined
  try {
    const dataFolder = await getServiceHub().app().getJanDataFolder()
    if (dataFolder) {
      writeGrant = extras.length
        ? await directEditAuthorize(dataFolder, ctx.roomId, folder, extras)
        : await directEditAuthorize(dataFolder, ctx.roomId, folder)
    }
  } catch {
    // No grant: reads and commands still work, writes are refused by the gate.
  }

  const who = ctx.participantName ?? 'A participant'
  const dispatchContext: DispatchContext = {
    sessionId: ctx.roomId,
    activity: { session: ctx.roomId, run: ctx.roomId, agent: who, project: folder },
    readOnlyFolder: folder,
    extraFolders: extras,
    mode: 'ask',
    webSearch: useWebSearchConfig.getState().webSearchEnabled,
    access: writeGrant ? 'edit-folder' : 'review-only',
    editConsent: { sessionId: ctx.roomId, folder },
    accessCapability: { managedWorktree: false, directEdit: Boolean(writeGrant) },
    writeGrant,
    bindingIntact: () => true,
    onTodo: refused('The todo list'),
    onAsk: refused('Asking the user a question'),
    onTask: refused('A subagent'),
    onApprove: (callId, toolName, input, preview, signal, forced) =>
      useToolApprovalRequests.getState().requestApproval(callId, toolName, ctx.roomId, undefined, {
        input,
        ...(forced
          ? {
              alwaysAsk: true,
              taskContext: forced.reason,
              conversationProgram: forced.conversationProgram,
              onDecision: forced.onDecision,
            }
          : {}),
        workspaceLabel: folder,
        preview,
        origin: who,
        signal: signal ?? ctx.signal,
      }),
  }

  const tools: Record<string, Tool> = {}
  for (const schema of await getAgentToolSchemas(folder, undefined, 'thread')) {
    const name = schema.function.name
    if (withheld(name)) continue
    tools[name] = {
      description: schema.function.description,
      inputSchema: jsonSchema(schema.function.parameters as Record<string, unknown>),
      execute: async (input: unknown, options?: { toolCallId?: string; abortSignal?: AbortSignal }) => {
        const outcome = await dispatchCoworkTool(
          {
            toolCallId: options?.toolCallId ?? `${ctx.roomId}:${name}:${Date.now()}`,
            toolName: name,
            input,
          },
          dispatchContext,
          options?.abortSignal ?? ctx.signal
        )
        const output = outcome.isError ? `ERROR: ${outcome.output}` : outcome.output
        onActivity?.({
          name,
          ok: !outcome.isError,
          args: input,
          output: output.length > OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n… (truncated)` : output,
        })
        return output
      },
    } as Tool
  }
  return tools
}
