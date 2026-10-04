/**
 * Delegation for the surfaces that are not Cowork: plain chat and Rooms.
 *
 * Cowork builds its child runner out of a run's frozen answers (access, grant,
 * worktree, instructions). A chat or a Room has none of those: its attached
 * folders are read-only, its tools run in the conversation's own workspace, and
 * a change still asks. This builds the same `coworkChildRunner` with that
 * smaller `setup`, and routes the `task` family through the same
 * `routeDelegationTool` Cowork uses, so a child is started, recorded, stopped,
 * capped and awaited identically wherever it was asked for.
 *
 * What a child here may do is what its parent surface may do and no more:
 * its calls go through `dispatchCoworkTool` in Ask mode, so anything that
 * changes something or runs a command waits for the person, through the same
 * approval store and the same `CoworkChildApprovals` card. It has no `todo`,
 * `ask`, `task` or `team`, and the attached folders stay read-only.
 */
import { jsonSchema, type LanguageModel, type Tool } from 'ai'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { getAgentToolSchemas, sandboxEnforces } from '@/lib/agentTools'
import { BackgroundTasks } from '@/lib/coworkBackgroundTasks'
import { createChildRunner } from '@/lib/coworkChildRunner'
import { dispatchCoworkTool, routeDelegationTool } from '@/lib/coworkDispatch'
import {
  abortSubagent,
  ensureRun,
  type PendingToolCall,
  type ToolOutcome,
} from '@/lib/coworkRunner'
import {
  parseSubagentRequest,
  SUBAGENT_RESULT_HEAD_CHARS,
  subagentActorId,
  type RunSubagentOptions,
} from '@/lib/coworkSubagent'
import { listSubagents } from '@/lib/coworkSubagentRegistry'
import { taskIdFor } from '@/lib/coworkActivity'
import { WEB_FETCH_DESCRIPTION, WEB_FETCH_INPUT_SCHEMA, WEB_SEARCH_DESCRIPTION, WEB_SEARCH_INPUT_SCHEMA } from '@/lib/webSearchTool'
import { delegationTools, TASK_TOOL_NAME, type DelegationOptions } from '@/lib/coworkTools'
import { BACKGROUND_TASK_TOOLS } from '@/lib/coworkBackgroundTasks'

/** The built-in tools a delegated child may hold on these surfaces. */
export const SURFACE_CHILD_TOOLS = [
  'read',
  'ls',
  'find',
  'grep',
  'write',
  'edit',
  'bash',
  'skill_list',
  'skill_read',
] as const

/** Steps one child may take on a surface with no run budget of its own. */
export const SURFACE_CHILD_MAX_STEPS = 15

export const SURFACE_DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  TASK_TOOL_NAME,
  ...BACKGROUND_TASK_TOOLS,
])

export type SurfaceDelegationSpec = {
  /** The conversation or room id: the owner of the children's records. */
  id: string
  /** The turn the next child belongs to; read at each dispatch. */
  runId: () => string
  title: string
  /** Attached folders, read-only. */
  folders: string[]
  model: () => LanguageModel | null | undefined
  modelId: string
  providerOptions: () => RunSubagentOptions['providerOptions']
  /** Stops every child this surface started. */
  signal: AbortSignal
  /** Who asked, named on the approval prompts a child raises. */
  asker?: string
  /** `chat` for both: the activity source the record knows. */
  background: boolean
  scope: 'thread' | 'session'
  maxSteps?: number
  /** The most tokens a child may spend; see the child runner. */
  tokenLimit?: () => number | undefined
  onUsage?: (usage: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | null) => void
}

export type SurfaceDelegation = {
  /** The tools to advertise. */
  tools: Record<string, Tool>
  tasks: BackgroundTasks
  /** Run one delegation tool call. Always resolves. */
  run: (call: PendingToolCall, signal?: AbortSignal) => Promise<ToolOutcome>
}

const options = (background: boolean): DelegationOptions => ({
  team: false,
  isolate: false,
  background,
})

/** The child's tool definitions, from the backend's own schemas. */
async function childTools(
  folder: string | undefined,
  scope: 'thread' | 'session',
  webSearch: boolean
): Promise<Record<string, Tool>> {
  const out: Record<string, Tool> = {}
  const allowed = new Set<string>(SURFACE_CHILD_TOOLS)
  for (const schema of await getAgentToolSchemas(folder, undefined, scope)) {
    const name = schema.function.name
    if (!allowed.has(name)) continue
    out[name] = {
      description: schema.function.description,
      inputSchema: jsonSchema(schema.function.parameters as Record<string, unknown>),
    } as Tool
  }
  if (webSearch) {
    out.web_search = {
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: jsonSchema(WEB_SEARCH_INPUT_SCHEMA as Record<string, unknown>),
    } as Tool
    out.web_fetch = {
      description: WEB_FETCH_DESCRIPTION,
      inputSchema: jsonSchema(WEB_FETCH_INPUT_SCHEMA as Record<string, unknown>),
    } as Tool
  }
  return out
}

/**
 * Build a surface's delegation: the tools to advertise and the function that
 * runs a call. Async because the tool definitions and the saved subagents are
 * read from the backend.
 */
export async function createSurfaceDelegation(
  spec: SurfaceDelegationSpec
): Promise<SurfaceDelegation> {
  const definitions = await listSubagents()
  const webSearch = useWebSearchConfig.getState().webSearchEnabled
  const folder = spec.folders[0]
  const parentTools = await childTools(folder, spec.scope, webSearch)
  const tasks = new BackgroundTasks(SUBAGENT_RESULT_HEAD_CHARS)
  const names = definitions.map((d) => d.name)
  const tools = delegationTools(names, options(spec.background))

  const runnerFor = () =>
    createChildRunner({
      sessionId: spec.id,
      runId: spec.runId(),
      run: { sessionId: spec.id, runId: spec.runId(), title: spec.title, model: spec.modelId },
      modelId: spec.modelId,
      definitions,
      signal: spec.signal,
      model: spec.model,
      providerOptions: spec.providerOptions,
      parentTools: () => parentTools,
      anchorMessageId: () => undefined,
      activitySource: 'chat',
      maxSteps: spec.maxSteps ?? SURFACE_CHILD_MAX_STEPS,
      tokenLimit: spec.tokenLimit,
      onUsage: spec.onUsage,
      setup: (resolved) => {
        const identity = {
          session: spec.id,
          run: spec.runId(),
          agent: resolved.name,
          agentId: subagentActorId(resolved),
          parentAgent: spec.asker ?? 'agent',
          project: folder ?? '',
        }
        return {
          activity: () => identity,
          system: {
            workspacePath: null,
            readOnlyFolder: folder ?? null,
            extraFolders: spec.folders.slice(1),
            bashAvailable: sandboxEnforces(),
            folderAccess: 'read-only',
          },
          dispatch: (call, toolSignal) =>
            dispatchCoworkTool(
              call,
              {
                activity: identity,
                sessionId: spec.id,
                scope: spec.scope,
                readOnlyFolder: folder ?? null,
                extraFolders: spec.folders.slice(1),
                mode: 'ask',
                webSearch,
                access: 'review-only',
                bindingIntact: () => true,
                onApprove: (callId, toolName, input, preview, signal, forced) =>
                  useToolApprovalRequests
                    .getState()
                    .requestApproval(callId, toolName, spec.id, undefined, {
                      input,
                      ...(forced
                        ? {
                            alwaysAsk: true,
                            taskContext: forced.reason,
                            conversationProgram: forced.conversationProgram,
                            onDecision: forced.onDecision,
                          }
                        : {}),
                      preview,
                      origin: resolved.name,
                      signal,
                    }),
                onTodo: async () => ({
                  output: 'The todo list belongs to the agent that dispatched you.',
                  isError: true,
                }),
                onAsk: async () => ({
                  output: 'You cannot ask the user questions. Decide, and say what you assumed.',
                  isError: true,
                }),
                onTask: async () => ({
                  output: 'A subagent cannot dispatch subagents.',
                  isError: true,
                }),
              },
              toolSignal
            ),
        }
      },
    })

  const run = async (call: PendingToolCall, signal?: AbortSignal): Promise<ToolOutcome> => {
    // Somewhere for each child's own Stop to live; see `ensureRun`.
    ensureRun(spec.id, spec.runId(), new AbortController())
    const runner = runnerFor()
    return routeDelegationTool(
      call,
      {
        tasks: spec.background ? tasks : undefined,
        onTask: async (callId, input) => {
          const req = parseSubagentRequest(input)
          if (typeof req === 'string') return { output: `ERROR: ${req}`, isError: true }
          return runner(callId, req)
        },
        cancelChild: (callId) =>
          abortSubagent(spec.id, taskIdFor(spec.id, spec.runId(), callId)),
      },
      signal
    )
  }

  return { tools, tasks, run }
}
