import { pushNotice } from '@/lib/coworkRunNotices'
import {
  ANSWER_SUBAGENT_TOOL_NAME,
  answerSubagent,
} from '@/lib/coworkSubagentQuestions'
import { executeAgentTool, previewAgentChange } from '@/lib/agentTools'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import {
  approvalSourceFor,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { deriveToolOutputCap } from '@/lib/context-manager'
import { destructiveCommandReason } from '@/lib/destructiveCommand'
import { isReadOnlyCommand } from '@/lib/readOnlyCommand'
import { normalizeEditInput } from '@/lib/coworkEditInput'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import {
  noteAutoApproved,
  resetAutoApproveStreak,
  autoApprovePauseReason,
  useAutoApproveLimit,
} from '@/hooks/useAutoApproveLimit'
import {
  ASK_TOOL_NAME,
  PLAN_DENIED_TOOLS,
  isReviewDeniedBrowserTool,
  TASK_TOOL_NAME,
  TEAM_TOOL_NAME,
  TODO_TOOL_NAME,
} from '@/lib/coworkTools'
import { isolatedTaskAsTeam } from '@/lib/coworkTeam'
import {
  BACKGROUND_TASK_TOOLS,
  omitFull,
  runBackgroundTool,
  type BackgroundTasks,
} from '@/lib/coworkBackgroundTasks'
import { isReadOnly, type CoworkMode } from '@/lib/coworkMode'
import { isBrowserTool } from '@/lib/browserAgent'
import { BROWSER_TOOL_NAME } from '@/lib/browserTool'
import { isVisualizeTool } from '@/lib/visualize/constants'
import { executeVisualizeTool } from '@/lib/visualize/tools'
import { attribute, sealed } from '@/lib/coworkPrompt'
import {
  isMissingPathError,
  missingReadGuidance,
  planReviewRequest,
} from '@/lib/coworkPlanReview'
import {
  BACKEND_ACCESS_CAPABILITY,
  decideMutation,
  writesInsideSessionTree,
  type AccessCapability,
  type AccessMode,
  type EditConsent,
} from '@/lib/coworkAccess'
import type { PendingToolCall, ToolOutcome } from '@/lib/coworkRunner'
import {
  recordToolActivity,
  resourceOf,
  withToolActivity,
  actorFor,
  type ToolActivityContext,
} from '@/lib/toolActivity'
import { WEB_TOOL_NAMES, executeWebTool } from '@/lib/webSearchTool'
import {
  NULL_DEVICE_RETRY_REASON,
  offerUnsandboxedRetry,
  commandProgram,
  nullRerunApprovalScope,
} from '@/lib/nullDeviceRetry'
import { STOP_SESSION_TOOL_NAME } from '@/lib/sessionMessagingTools'
import { gateStopSession } from '@/lib/sessionStopGate'
import {
  GIT_TOOL_NAME,
  gitApproval,
  gitInsideSessionTree,
  gitRemoteFacts,
  type GitPlan,
} from '@/lib/gitTool'
import { usePrStatusStore } from '@/stores/pr-status-store'
import type { DelegationNudge } from '@/lib/delegationNudge'
import { recordSessionPr } from '@/lib/prClaimBackfill'
import { attributeGitInput } from '@/lib/gitAttribution'

export type DispatchContext = {
  sessionId: string
  /**
   * Identity the call's lifecycle events are recorded under. AH-050.
   *
   * Optional so a caller that has no run to name still records something
   * useful rather than nothing: without it the events carry the session alone.
   */
  activity?: Partial<ToolActivityContext>
  readOnlyFolder: string | null
  /**
   * The model this run is using, named in the co-author trailer Flint adds to
   * a `git` commit. Absent, the trailer names Flint alone.
   */
  modelId?: string
  /**
   * The session's additional attached folders, readable (and, under a live
   * grant, writable) exactly like the primary one.
   */
  extraFolders?: readonly string[]
  /** What this session is allowed to do. */
  mode: CoworkMode
  /** Mirrors the advertised set. Refused when off, so a call to a tool that was
   * never advertised cannot reach the network the user switched off. */
  webSearch: boolean
  /**
   * The MCP server a tool of this request belongs to. Only the tools the run
   * advertised from a connected server answer; any other name is not MCP.
   */
  mcpServerFor?: (toolName: string) => string | undefined
  /**
   * Puts one MCP call to the user, with its server named so the standing
   * trust for that server applies. Absent, an MCP call is refused: the gate
   * failing open would make a tool that appeared mid-chat auto-approved.
   */
  onApproveMcp?: (
    toolCallId: string,
    toolName: string,
    input: unknown,
    server: string,
    signal?: AbortSignal
  ) => Promise<boolean>
  /**
   * A call was refused for reaching outside the sandbox while the session has
   * no folder. Asks the user whether to attach one; `'attached'` means they
   * picked it and the run should end so it restarts with that folder, since a
   * run's folder is fixed once it has started.
   */
  onNeedFolder?: (info: {
    toolName: string
    detail: string
    signal?: AbortSignal
  }) => Promise<'attached' | 'declined'>
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
    input: unknown,
    /** The diff the call would make, when it changes a file. AH-146. */
    preview?: string,
    /** The run's signal: stopping the run withdraws the prompt. */
    signal?: AbortSignal,
    /**
     * Set when the call must be put to the user even if a standing grant or
     * the mode would allow it: a destructive command, or the pause after a
     * long auto-approved streak. `reason` is shown in the prompt.
     */
    options?: {
      alwaysAsk: true
      reason: string
      /** Offer "Allow for this conversation" for this program only. */
      conversationProgram?: string
      onDecision?: (decision: string) => void
    }
  ) => Promise<boolean>
  /**
   * Is the folder this run was bound to still the session's folder?
   *
   * A run captures its root once, at the start. If the user detaches that
   * folder or picks a different one while the run is in flight, every later
   * tool call would still read the old root — the run would go on reading a
   * repository the user has already taken away. Asked per call, immediately
   * before the filesystem is touched, so the answer cannot be stale.
   */
  bindingIntact?: () => boolean
  /**
   * Skills the user asked for that are not in play.
   *
   * Reading is still fine — that is what Review first is for — but changing
   * files while ignoring the instructions those changes were meant to follow
   * is not. Empty when everything resolved, which is the ordinary case.
   */
  unresolvedSkills?: readonly {
    requested: string
    state: string
    trigger?: string
  }[]
  /**
   * Which workspace namespace the tools run in. Cowork's `session` is the
   * default; plain chat passes `thread`, so a delegated child works in the
   * same workspace as the conversation that asked for it.
   */
  scope?: 'thread' | 'session'
  /** Where this session may write. Absent is Review only. */
  access?: AccessMode
  /** The user's confirmation to edit the attached folder, when given. */
  editConsent?: EditConsent
  /** What the backend can enforce. Absent is what it enforces today. */
  accessCapability?: AccessCapability
  /** A managed worktree's path, once one exists. */
  worktreePath?: string | null
  /**
   * The run's opaque write grant, frozen at dispatch.
   *
   * Passed straight through to the backend, which resolves it against this
   * session. It is authority-bearing: it must not reach a prompt, a message,
   * an activity row, or anything a user or model can read.
   */
  writeGrant?: string | null
  /**
   * Gives a model that keeps reading a survey itself a one-line pointer to
   * the delegation tool (see `DelegationNudge`). Only the run's own dispatcher
   * has one; a child's has none.
   */
  nudge?: DelegationNudge
  /** Runs a nested subagent to completion. */
  onTask: (toolCallId: string, input: unknown) => Promise<ToolOutcome>
  /**
   * This run's background tasks (`task` with `background: true`). Absent for a
   * subagent's own dispatcher: a child starts, awaits and stops nothing.
   */
  tasks?: BackgroundTasks
  /** Stop one child by its call id; false when there was nothing to stop. */
  cancelChild?: (callId: string) => boolean
  /**
   * Runs a declared task graph as several children.
   *
   * Optional: a subagent's own dispatcher has no team, and a run without one
   * refuses the call by name rather than executing a tool that was never
   * advertised.
   */
  onTeam?: (toolCallId: string, input: unknown) => Promise<ToolOutcome>
  /**
   * Instructions that govern one path's subtree and have not been delivered.
   *
   * A nested `CLAUDE.md` applies under its own directory. There is one system
   * prompt per run, so a subtree's rules cannot be in it from the start
   * without also applying everywhere else — which is the opposite of what the
   * file says. Instead they are handed over the first time work reaches that
   * subtree, before anything there is changed.
   *
   * Returns the chain still owed for `path`, and records it as delivered.
   * Absent when there are no nested files, which is the ordinary case.
   */
  scopedInstructions?: (
    path: string
  ) => { scope: string; name: string; content: string }[]
  /**
   * Registers a shell that is running right now, and returns its release.
   *
   * A run releases its own hold when its stream ends, and cancelling a run
   * ends that stream immediately — but the shell it already handed to the
   * backend keeps running, and keeps writing, under the authority it started
   * with. Held separately for exactly that window, so the folder cannot be
   * swapped out from under a process that is still going.
   *
   * Optional: a caller with no active-work model simply tracks nothing.
   */
  trackShell?: () => () => void
  /**
   * Registers a subagent that is running right now, and returns its release.
   *
   * Held for the whole `task` call — queued, running, and winding down — so a
   * child writing under the authority it inherited keeps that authority in
   * place. A subagent cannot widen it: the hold carries the parent's frozen
   * authority, and there is nothing here that could raise it.
   */
  trackSubagent?: () => () => void
  /**
   * Paths a `read` in this run found missing, and how often. janhq/jan#8906.
   *
   * One map per run, so the history never outlives the request it describes.
   * Absent, a missing read is still explained but never escalated.
   */
  readFailures?: Map<string, number>
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

/** The folder the run was bound to is no longer the session's folder. */
function detachedRefusal(toolName: string): ToolOutcome {
  return {
    output:
      `The folder this session was working in is no longer attached, so ` +
      `\`${toolName}\` was not run. Stop, say what was done so far, and ` +
      'wait for the user to choose a folder again.',
    isError: true,
  }
}

/** A skill the user asked for is not in play, so nothing may change. */
function skillRefusal(
  toolName: string,
  unresolved: readonly { requested: string; state: string; trigger?: string }[]
): ToolOutcome {
  const named = unresolved
    .map((skill) => `${skill.requested} (${skill.state})`)
    .join(', ')
  // Name the text that was read as a request: a robocopy switch quoted in a
  // Continue request once read as seven "missing" skills, and neither the
  // model nor the user could tell where they came from.
  const triggers = unresolved
    .map((skill) =>
      skill.trigger
        ? `\`${skill.trigger}\``
        : `\`/${skill.requested}\` or \`@${skill.requested}\``
    )
    .join(', ')
  return {
    output:
      `\`${toolName}\` was not run: you were asked to use ${named}, and ` +
      'that is not in effect. Do not work around it. Say which skill is ' +
      'unavailable and what the user can do about it, then stop. ' +
      `This was read from ${triggers} in the user's message. If that text ` +
      'is a command switch, a path or a file name rather than a skill, tell ' +
      'the user to put it in backticks or code, or to write it without the ' +
      'leading / or @, and send the request again.',
    isError: true,
  }
}

/**
 * The path a tool call is about to act on, where it names one.
 *
 * Deliberately only the declared argument. Guessing at paths inside a shell
 * command would be a parser pretending to know what a command will touch; the
 * sandbox is what actually bounds that, and a shell's scope comes from its
 * working directory instead.
 */
function pathFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'file', 'target', 'cwd']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/**
 * Hand over a subtree's instructions and ask for the call again.
 *
 * A refusal rather than a warning attached to a completed write: the whole
 * point of a scoped instruction file is that it governs the change, so the
 * change has to happen after it has been read. The retry is explicit so the
 * model does not treat this as a failure to work around.
 */
function scopedInstructionsOwed(
  toolName: string,
  path: string,
  owed: { scope: string; name: string; content: string }[]
): ToolOutcome {
  // Neutralised exactly as the root-level files are in the system prompt: the
  // content is a repository's, and must not be able to close its own envelope
  // and speak as the harness, nor a directory name add attributes to the tag
  // (Jozkah/jan#97).
  const blocks = owed
    .map((one) =>
      [
        `<project_instructions path="${attribute(`${one.scope}/${one.name}`)}" applies_to="${attribute(`${one.scope}/`)}">`,
        sealed(one.content.trim()),
        '</project_instructions>',
      ].join('\n')
    )
    .join('\n\n')

  return {
    output:
      `\`${toolName}\` was not run yet: \`${path}\` is under a directory with ` +
      'its own instructions, which you had not been given. They are below, ' +
      'they apply to everything under that directory, and they rank below ' +
      '`FLINT.md` and this system prompt where they disagree. Read them, then ' +
      'make the same call again.\n\n' +
      blocks,
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

/** The backend's refusal for a path outside the sandbox and every granted folder. */
export function isOutsideWorkspaceError(error: string): boolean {
  return (
    error.includes('is outside the workspace and every folder the user has granted') ||
    error.includes('[sandbox_denied]')
  )
}

/**
 * One call to a tool of a connected MCP server.
 *
 * Gated like the chat's: the call is put to the user unless a grant they made
 * already covers this server, whenever the server appeared. The backend then
 * checks its own trust record, and a ticket minted from this approval is what
 * lets an untrusted server's single call through.
 */
async function callMcpTool(
  call: PendingToolCall,
  server: string,
  ctx: DispatchContext,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  const { toolName } = call
  if (isReadOnly(ctx.mode)) return planRefusal(toolName)
  // The disabled list filters what is advertised, not what runs: a call the
  // model repeats from earlier in the conversation must not slip past it.
  if (useToolAvailable.getState().isToolDisabled(server, toolName)) {
    return { output: `Tool '${toolName}' is disabled.`, isError: true }
  }
  const permission = {
    call: call.toolCallId,
    tool: toolName,
    session: ctx.sessionId,
    run: ctx.activity?.run ?? '',
    invocation: ctx.activity?.invocation ?? '',
    agent: ctx.activity?.agent ?? '',
    resource: resourceOf(call.input),
  }
  // The unasked streak is left to the approval queue: it counts a call a grant
  // answers and starts over only when it prompts. Resetting here would let a
  // trusted server's calls never reach the limit.
  // The session's own Bypass mode, not only the global one: it is chosen per
  // session, so the approval queue (which reads the global mode) cannot see it.
  const bypassed = ctx.mode === 'bypass'
  if (!bypassed) {
    await recordToolActivity({ ...permission, phase: 'awaiting-permission' })
  }
  if (!bypassed && !ctx.onApproveMcp) {
    await recordToolActivity({
      ...permission,
      phase: 'refused',
      detail: 'nothing could present the request',
    })
    return deniedByUser(toolName)
  }
  let allowed = bypassed
  if (!bypassed) {
    try {
      allowed = await unlessStopped(
        ctx.onApproveMcp!(call.toolCallId, toolName, call.input, server, signal),
        signal
      )
    } catch {
      allowed = false
    }
  }
  if (signal?.aborted) {
    await recordToolActivity({
      ...permission,
      phase: 'cancelled',
      detail: `approval withdrawn: ${stopReason(signal)}`,
    })
    return {
      output:
        `\`${toolName}\` was not run: the run was stopped while it was ` +
        'waiting for approval.',
      isError: true,
    }
  }
  // Who decided, so a call that ran without a click can be told apart from one
  // the person allowed: 'prompted' is the card's own button, 'auto' a standing
  // grant that already covered this server.
  await recordToolActivity({
    ...permission,
    phase: allowed ? 'allowed' : 'refused',
    ...(allowed
      ? {
          detail: `decided by ${bypassed ? 'bypass' : approvalSourceFor(call.toolCallId)}`,
        }
      : {}),
  })
  if (!allowed) return deniedByUser(toolName)

  try {
    const mcp = getServiceHub().mcp()
    const fingerprint = useToolApprovalRequests
      .getState()
      .takeApprovedFingerprint?.(call.toolCallId)
    const approvalTicket = await mcp
      .allowOnceForServer(server, toolName, fingerprint)
      .catch(() => undefined)
    const result = await mcp.callTool({
      toolName,
      serverName: server,
      arguments: (call.input ?? {}) as object,
      approvalTicket,
      maxOutputChars: deriveToolOutputCap(undefined),
    })
    const failure = result.error
      ? String(result.error)
      : (result as { isError?: unknown }).isError === true
        ? JSON.stringify(result.content ?? '')
        : undefined
    if (failure) return { output: failure, isError: true }
    return {
      output: (result.content ?? []).map((c) => c.text).join('\n'),
    }
  } catch (error) {
    return {
      output: error instanceof Error ? error.message : String(error),
      isError: true,
    }
  }
}

/**
 * Route one tool call, recording its whole life on the way. AH-050.
 *
 * Every tool call in the app arrives here -- the main agent's, a subagent's, a
 * background task's, an MCP server's -- so wrapping this one function is what
 * makes the record complete, and is why no tool has a path around it.
 */
export async function dispatchCoworkTool(
  call: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  const outcome = await withToolActivity(
    call,
    { session: ctx.sessionId, run: '', ...(ctx.activity ?? {}) },
    signal,
    () => boundedToolCall(call, ctx, signal)
  )
  // A hint rides on the result the model is about to read, so it is read.
  const hint = ctx.nudge?.observe(call.toolName)
  if (hint && !outcome.isError) outcome.output = `${outcome.output}\n\n[${hint}]`
  // A pull request the call opened or named is this session's, whatever
  // branch the attached folder has checked out.
  if (!outcome.isError) {
    try {
      recordSessionPr(ctx.sessionId, call.toolName, call.input, outcome.output)
    } catch {
      // Recording is best effort; the call's answer stands.
    }
  }
  return outcome
}

const READ_ONLY_TIMEOUT_MS = 45_000
const BOUNDED_READ_TOOLS = new Set([
  'read', 'ls', 'find', 'grep', 'web_search', 'web_fetch',
])

/** Stop waiting when the run stops; bound reads that can otherwise hold a turn forever. */
function boundedToolCall(
  call: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  if (signal?.aborted) {
    return Promise.resolve({ output: 'Tool stopped before it returned.', isError: true })
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (outcome: ToolOutcome) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      resolve(outcome)
    }
    const stop = () => finish({ output: 'Tool stopped before it returned.', isError: true })
    const timer = BOUNDED_READ_TOOLS.has(call.toolName)
      ? setTimeout(
          () => finish({
            output: `ERROR: ${call.toolName} timed out after 45 seconds`,
            isError: true,
          }),
          READ_ONLY_TIMEOUT_MS
        )
      : undefined
    signal?.addEventListener('abort', stop, { once: true })
    void routeCoworkTool(call, ctx, signal).then(finish, (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      reject(error)
    })
  })
}

/** Resolves `false` as soon as `signal` aborts, whatever `answer` does. */
function unlessStopped(
  answer: Promise<boolean>,
  signal?: AbortSignal
): Promise<boolean> {
  if (!signal) return answer
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve, reject) => {
    const stop = () => resolve(false)
    signal.addEventListener('abort', stop, { once: true })
    answer.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      }
    )
  })
}

/** Why a run's signal aborted, in words for the record. */
function stopReason(signal: AbortSignal): string {
  const reason = signal.reason
  return typeof reason === 'string' && reason ? reason : 'cancelled'
}

/**
 * After a `git` call that can create or change a pull request succeeds --
 * a push, or any `gh pr` / `gh repo` write -- ask again for the session
 * folder's pull request, so the PR bar and the sidebar mark appear now. The
 * store otherwise asked only when the folder changed, and a "no pull
 * request" answer from before the agent opened one stood (session 8411d403:
 * `gh pr create` succeeded and no bar showed).
 */
export function refreshPrStatusAfterGit(
  plan: GitPlan,
  ctx: Pick<DispatchContext, 'readOnlyFolder' | 'worktreePath'> & { sessionId?: string }
): string[] {
  const opensPr =
    (plan.program === 'git' && plan.args[0] === 'push') ||
    (plan.program === 'gh' &&
      plan.class === 'remote' &&
      (plan.args[0] === 'pr' || plan.args[0] === 'repo'))
  if (!opensPr) return []
  const folders = [ctx.readOnlyFolder, ctx.worktreePath].filter(
    (f, i, all): f is string => !!f && all.indexOf(f) === i
  )
  for (const folder of folders) {
    // Claimed for this session: the pull request is the one it pushed or
    // opened, not every session's that shares the folder's checkout.
    void usePrStatusStore.getState().refresh(folder, true, ctx.sessionId)
  }
  return folders
}

/**
 * `task` and the tools that manage its background children, for any surface
 * that offers delegation: Cowork's dispatcher, plain chat and Rooms all route
 * these calls here so a child is started, awaited, stopped and capped the same
 * way wherever it was asked for.
 */
export async function routeDelegationTool(
  call: PendingToolCall,
  ctx: Pick<
    DispatchContext,
    'tasks' | 'onTask' | 'onTeam' | 'trackSubagent' | 'cancelChild'
  > & { sessionId?: string },
  signal?: AbortSignal
): Promise<ToolOutcome> {
  const { toolName } = call
  // Collecting, checking on and stopping this run's background tasks.
  if (BACKGROUND_TASK_TOOLS.has(toolName)) {
    if (!ctx.tasks) {
      return {
        output: 'You cannot manage background tasks. Do this work yourself.',
        isError: true,
      }
    }
    return await runBackgroundTool(toolName, call.input, ctx.tasks, { signal })
  }
  if (toolName === TASK_TOOL_NAME) {
    const taskInput = (
      call.input && typeof call.input === 'object' ? call.input : {}
    ) as Record<string, unknown>
    if (taskInput.background === true && ctx.tasks) {
      if (taskInput.isolate === true) {
        return {
          output:
            'ERROR: `background` cannot be combined with `isolate`. Run the isolated task in the foreground, or put it in a `team`.',
          isError: true,
        }
      }
      // Held for as long as the child lives, not just for this call: the
      // child inherits this run's authority until it is done.
      const childDone = ctx.trackSubagent?.()
      const id = call.toolCallId
      const name =
        typeof taskInput.subagent_name === 'string'
          ? taskInput.subagent_name
          : 'subagent'
      ctx.tasks.start(
        id,
        name,
        async () => {
          try {
            const done = await ctx.onTask(id, call.input)
            // Pushed to the parent at its next step boundary, so it need not
            // poll `task_status`. A stop the user asked for is not news.
            if (ctx.sessionId && !(done.isError && /cancelled/i.test(done.output))) {
              const preview = done.output.replace(/\s+/g, ' ').slice(0, 160)
              pushNotice(
                ctx.sessionId,
                `Background subagent '${name}' (task_id=${id}) ${done.isError ? 'failed' : 'finished'}: "${preview}". ` +
                  'Read the full answer with await_task.'
              )
            }
            return done
          } catch (e) {
            if (ctx.sessionId) {
              pushNotice(
                ctx.sessionId,
                `Background subagent '${name}' (task_id=${id}) failed to run.`
              )
            }
            throw e
          } finally {
            childDone?.()
          }
        },
        () => ctx.cancelChild?.(id) ?? false
      )
      return {
        output:
          `Task started in the background. task_id=${id}. Keep working; call await_task with this task_id to collect its answer, ` +
          'task_status to check on it, or cancel_task to stop it. The run waits for it before it ends.',
      }
    }
    // `isolate: true` is a team of one. The team path already provisions a
    // checkout for a task, records it for review, refuses when the project
    // cannot be isolated, and settles it afterwards; a second implementation
    // for a lone `task` would be a copy that drifts.
    const asTeam = ctx.onTeam ? isolatedTaskAsTeam(call.input) : null
    if (asTeam && 'error' in asTeam) {
      return { output: `ERROR: ${asTeam.error}`, isError: true }
    }
    if (asTeam && ctx.onTeam) {
      const teamDone = ctx.trackSubagent?.()
      try {
        return await ctx.onTeam(call.toolCallId, asTeam)
      } finally {
        teamDone?.()
      }
    }
    const childDone = ctx.trackSubagent?.()
    try {
      const done = await ctx.onTask(call.toolCallId, call.input)
      // A cut answer is kept for `await_task` reads; the whole text never
      // travels with the outcome.
      return ctx.tasks
        ? ctx.tasks.collect(call.toolCallId, done)
        : omitFull(done)
    } finally {
      childDone?.()
    }
  }
  return {
    output: `ERROR: \`${toolName}\` is not a delegation tool.`,
    isError: true,
  }
}

/**
 * Route one tool call. Always resolves: a rejection here would abort the run,
 * where the model can usually recover from being told what went wrong.
 */
async function routeCoworkTool(
  call: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  const { toolName } = call
  // `edit` with one top-level `old_string`/`new_string` pair is the shape
  // models reach for most often; it is the same request as a one-item
  // `edits` list, so it is sent as that rather than refused.
  if (toolName === 'edit') call = { ...call, input: normalizeEditInput(call.input) }

  // Stopping another session: asked every time, in every mode that offers it,
  // whatever grants exist; refused in review mode and where nothing can ask.
  if (toolName === STOP_SESSION_TOOL_NAME) {
    const refused = await gateStopSession(call, ctx, signal)
    if (refused) return refused
  }

  // `git`: a read runs straight away; anything else is a mutation and goes
  // through the same policy as `write` and `bash` below.
  // Flint's attribution on a commit or pull request, added before the call is
  // judged or asked about, so the prompt shows exactly what will land.
  if (toolName === GIT_TOOL_NAME) {
    call = {
      ...call,
      input: await attributeGitInput(
        call.input,
        ctx.modelId,
        ctx.worktreePath ?? ctx.readOnlyFolder,
        { id: ctx.sessionId, session: true }
      ),
    }
  }
  const git = toolName === GIT_TOOL_NAME ? gitApproval(call.input) : null

  // Every mutating call goes through the one policy, so the run mode and the
  // access mode cannot be answered differently in different places.
  if (PLAN_DENIED_TOOLS.has(toolName) || git) {
    const unresolved = ctx.unresolvedSkills ?? []
    const decision = decideMutation({
      runMode: ctx.mode,
      access: ctx.access ?? 'review-only',
      binding: { sessionId: ctx.sessionId, folder: ctx.readOnlyFolder },
      consent: ctx.editConsent,
      bindingIntact: ctx.bindingIntact ? ctx.bindingIntact() : true,
      unresolvedSkillCount: unresolved.length,
      capability: ctx.accessCapability ?? BACKEND_ACCESS_CAPABILITY,
      worktreePath: ctx.worktreePath,
    })

    if (!decision.allowed) {
      switch (decision.reason) {
        case 'review-mode':
          return planRefusal(toolName)
        case 'stale-binding':
          return detachedRefusal(toolName)
        case 'unresolved-skill':
          return skillRefusal(toolName, unresolved)
        case 'no-consent':
          return {
            output:
              `\`${toolName}\` was not run: editing this folder has not been ` +
              'confirmed for this session. Ask the user to confirm it, or ' +
              'work in the session workspace instead.',
            isError: true,
          }
        case 'unsupported-access':
          return {
            output:
              `\`${toolName}\` was not run: the selected access mode is not ` +
              'available in this build, so nothing outside the session ' +
              'workspace can be changed. Say so rather than working around it.',
            isError: true,
          }
      }
    }

    // Asked regardless of mode or grants: a command that matches a destructive
    // pattern, and -- in a mode that does not ask -- the call after a long
    // streak of unasked ones, so an unattended run checks in now and then.
    const command =
      toolName === 'bash' &&
      typeof (call.input as { command?: unknown } | undefined)?.command ===
        'string'
        ? (call.input as { command: string }).command
        : undefined
    const destructive = command
      ? destructiveCommandReason(
          command,
          ctx.worktreePath ?? ctx.readOnlyFolder ?? ''
        )
      : null
    // A shell line that only reads (listing, reading, `git status`, a tool's
    // `--version`) is not a change, so "Ask before changes" does not ask for
    // it, and it does not count toward the unasked streak either.
    const readOnlyShell =
      command !== undefined && !destructive && isReadOnlyCommand(command)
    // A local git change inside the session's own worktree or sandbox is the
    // run's ordinary work in Auto mode; anywhere else it is asked about. A
    // push, a pull request or a destructive command is asked about always.
    const gitOwnTree =
      !!git &&
      (ctx.mode === 'auto' || ctx.mode === 'bypass') &&
      gitInsideSessionTree(git.plan.cwd, ctx.worktreePath, !!ctx.writeGrant)
    const needsApproval = git
      ? !git.alwaysAsk && (decision.needsApproval || !gitOwnTree)
      : decision.needsApproval && !readOnlyShell
    // In Auto mode, a file write inside the session's own worktree or sandbox
    // is the run's ordinary work: it never pauses the run to ask.
    const ownTree =
      (ctx.mode === 'auto' || ctx.mode === 'bypass') &&
      writesInsideSessionTree(
        toolName,
        call.input,
        decision.destination,
        ctx.worktreePath
      )
    const overLimit =
      ctx.mode !== 'bypass' &&
      !git?.alwaysAsk &&
      !needsApproval &&
      !readOnlyShell &&
      !destructive &&
      !ownTree &&
      noteAutoApproved(ctx.sessionId, useAutoApproveLimit.getState().limit)
    // Only the approval card shows these facts; bypass never asks, so it must
    // not spend git round trips collecting them.
    const gitReason = git?.alwaysAsk && ctx.mode !== 'bypass'
      ? [
          git.reason,
          await gitRemoteFacts(git.plan, async (args) => {
            const r = await executeAgentTool(
              GIT_TOOL_NAME,
              { args, ...(git.plan.cwd ? { cwd: git.plan.cwd } : {}) },
              ctx.sessionId,
              {
                readOnlyProject: ctx.readOnlyFolder,
                extraProjects: ctx.extraFolders,
                scope: ctx.scope ?? 'session',
                writeGrant: ctx.writeGrant,
                // Its own call id, derived from the call it describes, so
                // the audit tells this lookup apart from the push itself.
                callId: `${call.toolCallId}:remote-facts`,
                undoRun: ctx.activity?.run,
              }
            )
            return r.error ? null : String(r.content ?? '')
          }),
        ]
          .filter(Boolean)
          .join(' ')
      : undefined
    const forced: { alwaysAsk: true; reason: string } | undefined = gitReason
      ? { alwaysAsk: true, reason: gitReason }
      : destructive
      ? {
          alwaysAsk: true,
          reason: `Destructive command: ${destructive}. Asked even though changes are otherwise allowed.`,
        }
      : overLimit
        ? {
            alwaysAsk: true,
            reason: autoApprovePauseReason(useAutoApproveLimit.getState().limit),
          }
        : undefined

    if (ctx.mode !== 'bypass' && (needsApproval || forced)) {
      resetAutoApproveStreak(ctx.sessionId)
      // Recorded separately from the outcome: "the user was asked" and "the
      // user said no" are different facts, and a refused call that was never
      // put to anyone is a bug worth being able to see.
      const permission = {
        call: call.toolCallId,
        tool: toolName,
        session: ctx.sessionId,
        run: ctx.activity?.run ?? '',
        invocation: ctx.activity?.invocation ?? '',
        agent: ctx.activity?.agent ?? '',
        resource: resourceOf(call.input),
      }
      await recordToolActivity({ ...permission, phase: 'awaiting-permission' })

      // No handler means nothing can present the request. Refusing is the
      // only honest outcome: running it would make "Ask before changes" false.
      if (!ctx.onApprove) {
        await recordToolActivity({
          ...permission,
          phase: 'refused',
          detail: 'nothing could present the request',
        })
        return deniedByUser(toolName)
      }
    // A throw here — an aborted run, a closed prompt — is a refusal, not a
    // reason to reject: this function always resolves.
      let allowed = false
      try {
        // The change itself, so what is approved is the diff that will land
        // rather than a path and a blob of arguments (AH-146). Computed by the
        // backend where this call would write; absent, the prompt still asks.
        const preview =
          toolName === 'write' || toolName === 'edit'
            ? await previewAgentChange(toolName, call.input, ctx.sessionId, {
                scope: ctx.scope ?? 'session',
                writeGrant: ctx.writeGrant,
              })
            : undefined
        allowed = await unlessStopped(
          // Only passed when set, so a plain prompt keeps its old arity.
          forced
            ? ctx.onApprove(
                call.toolCallId,
                toolName,
                call.input,
                preview,
                signal,
                forced
              )
            : ctx.onApprove(
                call.toolCallId,
                toolName,
                call.input,
                preview,
                signal
              ),
          signal
        )
      } catch {
        allowed = false
      }
      // Stopped while asking, or answered only after the stop: nobody's yes
      // or no. The prompt has been withdrawn, and the call never runs -- an
      // approval that arrives late must not act for a run that is over.
      if (signal?.aborted) {
        await recordToolActivity({
          ...permission,
          phase: 'cancelled',
          detail: `approval withdrawn: ${stopReason(signal)}`,
        })
        return {
          output:
            `\`${toolName}\` was not run: the run was stopped while it was ` +
            'waiting for approval, and nothing was changed.',
          isError: true,
        }
      }
      await recordToolActivity({
        ...permission,
        phase: allowed ? 'allowed' : 'refused',
      })
      if (!allowed) return deniedByUser(toolName)
    }
  }

  // Before the change, not after it: a mutation that lands and *then* reports
  // the rules it should have followed has already not followed them.
  if (PLAN_DENIED_TOOLS.has(toolName) && ctx.scopedInstructions) {
    const target = pathFromInput(call.input)
    if (target) {
      const owed = ctx.scopedInstructions(target)
      if (owed.length > 0) return scopedInstructionsOwed(toolName, target, owed)
    }
  }

  try {
    if (toolName === TODO_TOOL_NAME) return await ctx.onTodo(call.input)
    if (toolName === ASK_TOOL_NAME) {
      return await ctx.onAsk(call.toolCallId, call.input)
    }
    if (toolName === ANSWER_SUBAGENT_TOOL_NAME) {
      // The parent's side only: a child's dispatcher has no team.
      if (!ctx.onTeam) {
        return { output: 'You cannot answer subagent questions.', isError: true }
      }
      return answerSubagent(ctx.sessionId, call.input)
    }
    // `task` and the tools that manage its background children.
    if (toolName === TASK_TOOL_NAME || BACKGROUND_TASK_TOOLS.has(toolName)) {
      return await routeDelegationTool(call, ctx, signal)
    }
    if (toolName === TEAM_TOOL_NAME) {
      // A subagent's dispatcher has no team, so the call is refused by name
      // rather than executed: a model can emit a call to a tool that was never
      // advertised, and a child dispatching a team would be one level of
      // nesting past what the depth limit allows.
      if (!ctx.onTeam) {
        return {
          output:
            'You cannot dispatch a team. Do this work yourself, or report ' +
            'what you would need.',
          isError: true,
        }
      }
      // The team holds the parent's subagent slot for as long as it runs, the
      // same way one `task` does: its children are this run's children.
      const teamDone = ctx.trackSubagent?.()
      try {
        return await ctx.onTeam(call.toolCallId, call.input)
      } finally {
        teamDone?.()
      }
    }

    // Review mode changes nothing: a click or a keystroke can.
    if (isReviewDeniedBrowserTool(toolName) && isReadOnly(ctx.mode)) {
      return planRefusal(toolName)
    }

    const mcpServer = ctx.mcpServerFor?.(toolName)
    if (mcpServer) return await callMcpTool(call, mcpServer, ctx, signal)

    if (isVisualizeTool(toolName)) {
      const viz = executeVisualizeTool(toolName, call.input, ctx.sessionId)
      return viz.error !== undefined
        ? { output: viz.error, isError: true }
        : { output: viz.content ?? '' }
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

    // Checked here rather than at run start: this is the last moment before a
    // path is resolved, and the binding can change at any point before it.
    if (ctx.bindingIntact && !ctx.bindingIntact()) {
      return {
        output:
          `The folder this session was working in is no longer attached, so ` +
          `\`${toolName}\` was not run. Stop, say what was done so far, and ` +
          'wait for the user to choose a folder again.',
        isError: true,
      }
    }

    // Review mode, a `read` of a path this run already found missing: the
    // model is trying to create a file with the one tool that cannot. Asking
    // the filesystem again cannot end that loop; asking the user can.
    const readPath =
      toolName === 'read' && isReadOnly(ctx.mode) ? pathFromInput(call.input) : null
    const priorMisses = readPath ? (ctx.readFailures?.get(readPath) ?? 0) : 0
    if (readPath && priorMisses > 0) {
      const review = await ctx.onAsk(call.toolCallId, planReviewRequest(readPath))
      return {
        output:
          `\`${readPath}\` does not exist; it was not read again. ` +
          review.output,
        isError: true,
      }
    }

    // Held for the length of the call, and released on every way out of it —
    // output, refusal or throw.
    const shellDone = toolName === 'bash' ? ctx.trackShell?.() : undefined
    let result
    try {
      // `'session'`, not the default `'thread'`: a Cowork session id lives in
      // its own namespace, and the thread sweep would otherwise delete this
      // sandbox because no chat thread claims it.
      result = await executeAgentTool(toolName, call.input, ctx.sessionId, {
        readOnlyProject: ctx.readOnlyFolder,
        extraProjects: ctx.extraFolders,
        scope: ctx.scope ?? 'session',
        writeGrant: ctx.writeGrant,
        // The run the change belongs to, so it can be undone from it (AH-202).
        undoRun: ctx.activity?.run,
        // And the call, so what its command uses is kept against both (AH-174).
        callId: call.toolCallId,
        ...(ctx.mode === 'bypass' ? { approvalSource: 'bypass' as const } : {}),
        // And who is making it, so every change it journals names its agent
        // (AH-110) -- the primary agent, a named subagent, or a role.
        actor: actorFor(ctx.activity),
        // A `request_access` prompt is withdrawn when the run stops, and says
        // which task is asking.
        ...(toolName === 'request_access'
          ? { signal, taskLabel: 'Cowork session' }
          : {}),
        // Browser tools ask the user themselves (domain, action, submit).
        // Auto mode has nobody to ask: they then run only on sites a saved
        // rule or the project's allowed domains already cover.
        ...(isBrowserTool(toolName) || toolName === BROWSER_TOOL_NAME
          ? {
              signal,
              unattended: ctx.mode === 'auto',
              // Through Cowork's own prompt, as for an edit: the session's
              // grants apply, a subagent is named, and stopping the run
              // withdraws the question.
              approve: ({ context, url, alwaysAsk, input }) =>
                ctx.mode === 'bypass'
                  ? Promise.resolve(true)
                  : ctx.onApprove
                  ? unlessStopped(
                      ctx.onApprove(
                        call.toolCallId,
                        toolName,
                        input ?? call.input,
                        url ? `Page: ${url}` : undefined,
                        signal,
                        alwaysAsk ? { alwaysAsk: true, reason: context } : undefined
                      ),
                      signal
                    )
                  : Promise.resolve(false),
            }
          : {}),
        // Live command output for the terminal card, as the chat surface
        // does: raw, so it keeps the colours the model-facing result (which
        // the backend strips) does not.
        ...(toolName === 'bash'
          ? {
              onOutput: (text: string) =>
                useToolCallRuntime
                  .getState()
                  .appendOutput(call.toolCallId, text),
            }
          : {}),
      })
    } finally {
      shellDone?.()
    }
    // Failed only because Windows' null device refuses sandboxed programs:
    // offer the user this exact command outside the sandbox, through the same
    // prompt as any other approval, and answer the model with what happened.
    if (toolName === 'bash' && result.error && result.unsandboxedRetry) {
      const onApprove = ctx.onApprove
      resetAutoApproveStreak(ctx.sessionId)
      const settled = await offerUnsandboxedRetry({
        threadId: ctx.sessionId,
        retry: result.unsandboxedRetry,
        failure: result.error,
        failureResources: result.resources,
        program: commandProgram(call.input),
        ask: ctx.mode === 'bypass'
          ? () => Promise.resolve(true)
          : onApprove
          ? () =>
              unlessStopped(
                onApprove(call.toolCallId, toolName, call.input, undefined, signal, {
                  alwaysAsk: true,
                  reason: NULL_DEVICE_RETRY_REASON,
                  ...nullRerunApprovalScope(ctx.sessionId, call.input),
                }),
                signal
              )
          : undefined,
      })
      if (settled.firstAttempt) {
        useToolCallRuntime
          .getState()
          .recordFirstAttempt(call.toolCallId, settled.firstAttempt)
      }
      // The first attempt is display-only; the model gets the rerun.
      return {
        output: settled.output,
        isError: settled.isError,
        resources: settled.resources,
      }
    }
    if (result.error) {
      // The model reached for a path outside the sandbox and nothing is
      // attached: that is the user's call, not a dead end to retry around.
      if (
        ctx.onNeedFolder &&
        !ctx.readOnlyFolder &&
        isOutsideWorkspaceError(result.error)
      ) {
        const attached = await unlessStopped(
          ctx
            .onNeedFolder({ toolName, detail: result.error, signal })
            .then((answer) => answer === 'attached'),
          signal
        ).catch(() => false)
        if (attached) {
          return {
            output:
              `${result.error}\n\nThe user attached a project folder in response. ` +
              'This run ends here and restarts with that folder, so repeat the ' +
              'request once it does.',
            isError: true,
            endsTurn: true,
            resources: result.resources,
          }
        }
        return {
          output:
            `${result.error}\n\nThe user chose not to attach a folder. Do not ` +
            'retry this path; work from the sandbox, or say what you need.',
          isError: true,
          resources: result.resources,
        }
      }
      if (readPath && isMissingPathError(result.error)) {
        ctx.readFailures?.set(readPath, priorMisses + 1)
        return {
          output: result.error + missingReadGuidance(readPath),
          isError: true,
          resources: result.resources,
        }
      }
      return { output: result.error, isError: true, resources: result.resources }
    }
    // A path that reads now is not missing any more.
    if (readPath) ctx.readFailures?.delete(readPath)
    if (git) refreshPrStatusAfterGit(git.plan, ctx)
    return {
      output:
        typeof result.content === 'string'
          ? result.content
          : JSON.stringify(result.content ?? ''),
      diff: result.diff,
      resources: result.resources,
      ...(result.images?.length ? { images: result.images } : {}),
    }
  } catch (e) {
    return {
      output: e instanceof Error ? e.message : String(e),
      isError: true,
    }
  }
}
