import { jsonSchema, type LanguageModel, type Tool } from 'ai'
import { directEditAuthorize } from '@janhq/tauri-plugin-agent-tools-api'
import { getAgentToolSchemas } from '@/lib/agentTools'
import { dispatchCoworkTool, type DispatchContext } from '@/lib/coworkDispatch'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { getServiceHub } from '@/hooks/useServiceHub'
import { chatDelegationEnabled } from '@/lib/chatDelegation'
import { createSurfaceDelegation } from '@/lib/surfaceDelegation'
import type { RoomToolActivity, RoomToolContext } from './callError'

/** Steps a subagent a participant starts may take. Rooms are bounded, and a
 * turn that delegates is one participant's single reply. */
export const ROOM_CHILD_MAX_STEPS = 10

/**
 * What a Room participant needs to hand a job to a subagent: the model it is
 * speaking with, and a way to charge the room for what the child used.
 */
export type RoomDelegation = {
  model: () => LanguageModel | null | undefined
  modelId: string
  providerOptions: () => Record<string, never> | undefined
  /** The turn this child belongs to, so its records are grouped with it. */
  turnId: string
  onUsage: (usage: {
    total_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
  } | null) => void
}

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
  onActivity?: (a: RoomToolActivity) => void,
  delegation?: RoomDelegation
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

  // A participant with full access may hand a job to a subagent. Offered only
  // when the room can still pay for it, and only the foreground `task`: a Room
  // turn is one bounded reply, so there is nothing to run on beside it. The
  // child works in the room's folder under the same Ask-mode gate, is held to
  // the tokens the room has left, and its use is charged to the room.
  if (delegation && chatDelegationEnabled() && (ctx.tokenBudget ?? Infinity) > 0) {
    const remaining = ctx.tokenBudget
    const room = await createSurfaceDelegation({
      id: ctx.roomId,
      runId: () => `room:${ctx.roomId}:${delegation.turnId}`,
      title: ctx.participantName ?? 'Room',
      folders: [folder, ...extras],
      model: delegation.model,
      modelId: delegation.modelId,
      providerOptions: delegation.providerOptions as never,
      signal: ctx.signal ?? new AbortController().signal,
      asker: who,
      background: false,
      scope: 'session',
      maxSteps: ROOM_CHILD_MAX_STEPS,
      tokenLimit: remaining === undefined ? undefined : () => remaining,
      onUsage: delegation.onUsage,
    })
    const task = room.tools.task
    if (task) {
      tools.task = {
        ...task,
        execute: async (
          input: unknown,
          options?: { toolCallId?: string; abortSignal?: AbortSignal }
        ) => {
          const outcome = await room.run(
            {
              toolCallId: options?.toolCallId ?? `${ctx.roomId}:task:${Date.now()}`,
              toolName: 'task',
              input,
            },
            options?.abortSignal ?? ctx.signal
          )
          const output = outcome.isError ? `ERROR: ${outcome.output}` : outcome.output
          onActivity?.({
            name: 'task',
            ok: !outcome.isError,
            args: input,
            output: output.length > OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n… (truncated)` : output,
          })
          return output
        },
      } as Tool
    }
  }
  return tools
}
