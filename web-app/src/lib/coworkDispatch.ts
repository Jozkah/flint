import { executeAgentTool } from '@/lib/agentTools'
import {
  ASK_TOOL_NAME,
  TASK_TOOL_NAME,
  TODO_TOOL_NAME,
} from '@/lib/coworkTools'
import {
  deniedTools,
  needsApproval,
  type CoworkMode,
} from '@/lib/coworkMode'
import type { PendingToolCall, ToolOutcome } from '@/lib/coworkRunner'
import { WEB_TOOL_NAMES, executeWebTool } from '@/lib/webSearchTool'

export type DispatchContext = {
  sessionId: string
  readOnlyFolder: string | null
  /** What this session is allowed to do. */
  mode: CoworkMode
  /** Mirrors the advertised set. Refused when off, so a call to a tool that was
   * never advertised cannot reach the network the user switched off. */
  webSearch: boolean
  /** Applies one `todo` operation and persists the result. */
  onTodo: (input: unknown) => Promise<ToolOutcome>
  /** Suspends until the user answers, or the run is aborted. */
  onAsk: (toolCallId: string, input: unknown) => Promise<ToolOutcome>
  /**
   * Asks the user to allow one mutating call, in `ask` mode.
   *
   * Optional because not every caller can present a prompt — a subagent has no
   * composer of its own. Absent, a mutation is refused rather than run: the
   * gate failing open would make the mode a lie.
   */
  onApprove?: (
    toolCallId: string,
    toolName: string,
    input: unknown
  ) => Promise<boolean>
  /** Runs a nested subagent to completion. */
  onTask: (toolCallId: string, input: unknown) => Promise<ToolOutcome>
}

/**
 * Refusal text for a tool plan mode withholds.
 *
 * Withholding alone is not authoritative — a model can emit a call to a tool
 * that was never advertised, and the SDK still surfaces it — so the dispatcher
 * refuses by name too. The wording tells the model what to do instead, or it
 * simply retries.
 */
function planRefusal(toolName: string): ToolOutcome {
  return {
    output:
      `The \`${toolName}\` tool is disabled in review mode, which is ` +
      'read-only. Finish investigating, stage the plan with the `todo` tool, ' +
      'then call `ask` for review.',
    isError: true,
  }
}

/** The user was asked to allow this call and said no. */
function deniedByUser(toolName: string): ToolOutcome {
  return {
    output:
      `The user did not allow \`${toolName}\`. Do not retry it. Say what you ` +
      'would have changed, and wait for instructions.',
    isError: true,
  }
}

/**
 * Route one tool call. Always resolves: a rejection here would abort the run,
 * where the model can usually recover from being told what went wrong.
 */
export async function dispatchCoworkTool(
  call: PendingToolCall,
  ctx: DispatchContext
): Promise<ToolOutcome> {
  const { toolName } = call

  if (deniedTools(ctx.mode).has(toolName)) return planRefusal(toolName)

  if (needsApproval(ctx.mode, toolName)) {
    // No handler means nothing can present the request. Refusing is the only
    // honest outcome: running it would make "Ask before changes" false.
    if (!ctx.onApprove) return deniedByUser(toolName)
    // A throw here — an aborted run, a closed prompt — is a refusal, not a
    // reason to reject: this function always resolves.
    let allowed = false
    try {
      allowed = await ctx.onApprove(call.toolCallId, toolName, call.input)
    } catch {
      allowed = false
    }
    if (!allowed) return deniedByUser(toolName)
  }

  try {
    if (toolName === TODO_TOOL_NAME) return await ctx.onTodo(call.input)
    if (toolName === ASK_TOOL_NAME) {
      return await ctx.onAsk(call.toolCallId, call.input)
    }
    if (toolName === TASK_TOOL_NAME) {
      return await ctx.onTask(call.toolCallId, call.input)
    }

    if (WEB_TOOL_NAMES.has(toolName)) {
      if (!ctx.webSearch) {
        return {
          output:
            `The \`${toolName}\` tool is off: web access is disabled in ` +
            'Settings. Work from what you can read locally.',
          isError: true,
        }
      }
      const web = await executeWebTool(toolName, call.input ?? {})
      if (web.error) return { output: web.error, isError: true }
      return {
        output:
          typeof web.content === 'string'
            ? web.content
            : JSON.stringify(web.content ?? ''),
      }
    }

    // `'session'`, not the default `'thread'`: a Cowork session id lives in its
    // own namespace, and the thread sweep would otherwise delete this sandbox
    // because no chat thread claims it.
    const result = await executeAgentTool(
      toolName,
      call.input,
      ctx.sessionId,
      ctx.readOnlyFolder,
      'session'
    )
    if (result.error) return { output: result.error, isError: true }
    return {
      output:
        typeof result.content === 'string'
          ? result.content
          : JSON.stringify(result.content ?? ''),
      diff: result.diff,
    }
  } catch (e) {
    return {
      output: e instanceof Error ? e.message : String(e),
      isError: true,
    }
  }
}
