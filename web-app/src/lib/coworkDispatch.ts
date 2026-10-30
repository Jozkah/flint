import { workflowToTeamInput } from '@/lib/coworkWorkflow'
import { runWorkflowControl } from '@/lib/workflowControl'
import { describeSaved, resolveWorkflowInput } from '@/lib/savedWorkflows'
import { pushNotice } from '@/lib/coworkRunNotices'
import { registerToolCallStop, stopBackendCall } from '@/lib/toolCallStop'
import {
  ANSWER_SUBAGENT_TOOL_NAME,
  answerSubagent,
} from '@/lib/coworkSubagentQuestions'
import { executeAgentTool } from '@/lib/agentTools'
import { getServiceHub } from '@/hooks/useServiceHub'
import { fingerprintFor } from '@/lib/mcpFingerprint'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import {
  allApprovalRequests,
  approvalSourceFor,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { deriveToolOutputCap } from '@/lib/context-manager'
import { callMcpToolCancellable } from '@/lib/mcpCancellable'
import { normalizeEditInput } from '@/lib/coworkEditInput'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { resetAutoApproveStreak } from '@/hooks/useAutoApproveLimit'
import {
  ASK_TOOL_NAME,
  PLAN_DENIED_TOOLS,
  isReviewDeniedTool,
  TASK_TOOL_NAME,
  TEAM_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  TODO_TOOL_NAME,
} from '@/lib/coworkTools'
import { isolatedTaskAsTeam } from '@/lib/coworkTeam'
import { applyTaskDefaults } from '@/lib/coworkSubagent'
import type { SubagentDefinition } from '@/lib/coworkSubagentRegistry'
import { ENABLE_TOOLS_NAME } from '@/lib/coworkToolGroups'
import {
  BACKGROUND_TASK_TOOLS,
  omitFull,
  runBackgroundTool,
  type BackgroundTasks,
} from '@/lib/coworkBackgroundTasks'
import { isReadOnly, type CoworkMode } from '@/lib/coworkMode'
import { HOST_ASKED } from '@/lib/hostAsked'
import { useToolApproval } from '@/hooks/useToolApproval'
import { isBrowserTool } from '@/lib/browserAgent'
import { BROWSER_TOOL_NAME } from '@/lib/browserTool'
import { isVisualizeTool } from '@/lib/visualize/constants'
import { executeChatRead, isChatReadTool } from '@/lib/chatReadTool'
import { chatReadContextForSession } from '@/lib/chatMentionSources'
import { executeVisualizeTool } from '@/lib/visualize/tools'
import { attribute, sealed } from '@/lib/coworkPrompt'
import {
  isMissingPathError,
  missingReadGuidance,
  planReviewRequest,
} from '@/lib/coworkPlanReview'
import {
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
import { SPAWN_SESSION_TOOL_NAME, runSpawnSession } from '@/lib/spawnSession'
import {
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
  runEnterWorktree,
  runExitWorktree,
} from '@/lib/worktreeTools'
import { CAMPAIGN_TOOLS } from '@/lib/campaignToolNames'
import { gateStopSession } from '@/lib/sessionStopGate'
import { gateWorkflowLaunch } from '@/lib/workflowLaunchGate'
import {
  type GitPlan,
} from '@/lib/gitTool'
import { usePrStatusStore } from '@/stores/pr-status-store'
import type { DelegationNudge } from '@/lib/delegationNudge'
import { recordSessionPr } from '@/lib/prClaimBackfill'
import {
  bypassCannotOverride,
  deniedByUser,
  editedCalls,
  gateMutation,
  planRefusal,
  stopReason,
  unlessStopped,
} from '@/lib/cowork/approvalGate'

export { bypassCannotOverride }

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
  /**
   * The session's mode right now. `mode` is frozen when the run starts, so a
   * person who switches to Bypass while a call waits for approval would
   * otherwise keep getting asked. Only Bypass (in or out) and Review take
   * effect mid-run; see `effectiveMode`.
   */
  liveMode?: () => CoworkMode | undefined
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
   * `enable_tools`: advertise held-back tool groups from the next request.
   * Absent on a child's dispatcher, which is never offered the tool.
   */
  onEnableTools?: (input: unknown) => ToolOutcome
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
  /** A saved subagent by name, for its `background` / `isolation` defaults. */
  agentDefaults?: (name: string) => SubagentDefinition | undefined
  /**
   * Runs a declared task graph as several children.
   *
   * Optional: a subagent's own dispatcher has no team, and a run without one
   * refuses the call by name rather than executing a tool that was never
   * advertised.
   */
  onTeam?: (toolCallId: string, input: unknown) => Promise<ToolOutcome>
  /**
   * Runs a campaign tool (docs/CAMPAIGNS.md). Provided only by the main run
   * of a session that may coordinate a campaign. Absent for a campaign task,
   * a subagent and chat, so a call to one of those tools is refused there.
   */
  onCampaign?: (
    call: PendingToolCall,
    signal?: AbortSignal
  ) => Promise<ToolOutcome>
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


/** The folder the run was bound to is no longer the session's folder. */

/** A skill the user asked for is not in play, so nothing may change. */

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
          detail: bypassed
            ? AUTO_APPROVED_BYPASS
            : `decided by ${approvalSourceFor(call.toolCallId)}`,
        }
      : {}),
  })
  if (!allowed) return deniedByUser(toolName, call.toolCallId)

  try {
    const mcp = getServiceHub().mcp()
    const fingerprint = await fingerprintFor(
      mcp,
      server,
      useToolApprovalRequests.getState().takeApprovedFingerprint?.(call.toolCallId)
    )
    const approvalTicket = fingerprint
      ? await mcp.allowOnceForServer(server, toolName, fingerprint).catch(() => undefined)
      : undefined
    // Stop reaches the server at once, not at its timeout (M-011).
    const result = await callMcpToolCancellable(
      mcp,
      {
        toolName,
        serverName: server,
        arguments: (call.input ?? {}) as object,
        approvalTicket,
        maxOutputChars: deriveToolOutputCap(undefined),
      },
      signal
    )
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
 * `host_powershell` with no `cwd` in Review only, where its default folder
 * (the project) is read-only: refused up front with what would work instead.
 */
export function reviewOnlyPowershellRefusal(
  call: PendingToolCall,
  ctx: Pick<DispatchContext, 'mode' | 'readOnlyFolder'>
): ToolOutcome | null {
  if (call.toolName !== 'host_powershell') return null
  if (!isReadOnly(ctx.mode) || !ctx.readOnlyFolder) return null
  const cwd = (call.input as { cwd?: unknown } | null)?.cwd
  const named = typeof cwd === 'string' ? cwd.trim() : ''
  const inProject =
    !named ||
    named.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') ===
      ctx.readOnlyFolder.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  if (!inProject) return null
  return {
    output:
      '`host_powershell` was not run: this session is in Review only, so the ' +
      'project folder is read-only and PowerShell cannot run in it. Set `cwd` ' +
      'to the session workspace to run it there, or ask the user to switch ' +
      'the session to Edit.',
    isError: true,
  }
}


/** The result the model sees for a call the user edited before it ran. */
export function withEditNote(ranInput: unknown, output: string): string {
  const command = (ranInput as { command?: unknown } | null)?.command
  const what =
    typeof command === 'string' ? `\`${command}\`` : JSON.stringify(ranInput)
  return `The user edited the command before allowing it; this ran instead of yours: ${what}\n\n${output}`
}

/**
 * The mode a call runs under. A run's frozen mode stands, except that the
 * person's switch to Bypass, away from Bypass, or to Review while the run is
 * going applies to the next call: Bypass means no prompts, and it must not
 * take a restart to mean it. A run that started read-only stays read-only.
 */
export function effectiveMode(
  ctx: Pick<DispatchContext, 'mode' | 'liveMode'>
): CoworkMode {
  if (ctx.mode === 'review') return 'review'
  const live = ctx.liveMode?.()
  // The app-wide Bypass (Settings > Permissions) is Bypass here too.
  if (!live) {
    return useToolApproval.getState().permissionMode === 'bypass'
      ? 'bypass'
      : ctx.mode
  }
  return live === 'bypass' || live === 'review' || ctx.mode === 'bypass'
    ? live
    : ctx.mode
}

/** A refusal Bypass cannot lift says so, only while Bypass is on. */

/**
 * Does this backend error say a rule refused the call, rather than the call
 * failing? A deny rule, a tool rule, the sandbox, the network or secret-file
 * floors: nothing a person could answer, so Bypass cannot lift them.
 */
export function isPolicyRefusal(error: string): boolean {
  return /permission_denied|denied by (this machine|project|policy)|tool_rule|\[sandbox_denied\]|is outside the workspace and every folder|plan mode|plan_mode|refused:|was refused/i.test(
    error
  )
}

/** The audit text for a call Bypass let through without asking. */
export const AUTO_APPROVED_BYPASS = 'auto-approved (Bypass)'


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
  const mode = effectiveMode(ctx)
  if (mode !== ctx.mode) ctx = { ...ctx, mode }
  let outcome: Awaited<ReturnType<typeof boundedToolCall>>
  try {
    outcome = await withToolActivity(
      call,
      { session: ctx.sessionId, run: '', ...(ctx.activity ?? {}) },
      signal,
      () => boundedToolCall(call, ctx, signal)
    )
  } catch (error) {
    // A call that throws (timeout, abort) never reaches the read below; its
    // edited input must not stay in the map for the rest of the session.
    editedCalls.delete(call.toolCallId)
    throw error
  }
  // The user rewrote the command before allowing it: the row and the model's
  // copy show what ran, and the result says it was the user's edit.
  const ranInput = editedCalls.get(call.toolCallId)
  if (ranInput !== undefined) {
    editedCalls.delete(call.toolCallId)
    outcome.ranInput = ranInput
    outcome.output = withEditNote(ranInput, outcome.output)
  }
  // A hint travels beside the result, never inside it: text appended to a
  // file's content reads as part of the file.
  const hint = ctx.nudge?.observe(call.toolName)
  if (hint && !outcome.isError) outcome.note = hint
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
/** How long a read may sit on a question to the user before it is given up. */
const APPROVAL_WAIT_MAX_MS = 10 * 60_000
const BOUNDED_READ_TOOLS = new Set([
  'read', 'ls', 'find', 'grep', 'web_search', 'web_fetch', 'image_search',
  'chat_read',
])
/**
 * Commands get a generous last-resort wall clock of their own. The backend
 * bounds them far sooner (shell 150 s, git 120 s); this only matters when the
 * backend call itself never answers, which used to hold the run on "Running"
 * for good. It is not a shorter leash on a long build.
 */
const SHELL_TOOL_LIMIT_MS = 10 * 60_000
const isShellTool = (name: string) =>
  name === 'bash' || name === 'git' || name === 'git_clone' || name.startsWith('host_')

/** The wall clock for one call, or none. */
function limitFor(name: string): number | undefined {
  if (BOUNDED_READ_TOOLS.has(name)) return READ_ONLY_TIMEOUT_MS
  if (isShellTool(name)) return SHELL_TOOL_LIMIT_MS
  return undefined
}

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
      unregisterStop()
      signal?.removeEventListener('abort', stop)
      resolve(outcome)
    }
    const stop = () => finish({ output: 'Tool stopped before it returned.', isError: true })
    // "Stop this tool": ends the wait for this call only; the run goes on.
    const stoppedByUser = () =>
      finish({
        output: `${call.toolName} was stopped by the user before it finished. No result is available; carry on without it or try another approach.`,
        isError: true,
      })
    const unregisterStop = registerToolCallStop(call.toolCallId, stoppedByUser)
    // Time spent waiting for the user is not the tool being slow: while a
    // question of this session is open the clock is held, and only a question
    // left unanswered for a long time ends the call, saying so.
    const waitingOn = () =>
      allApprovalRequests(useToolApprovalRequests.getState()).find(
        (a) => a.threadId === ctx.sessionId
      )
    const startedAt = Date.now()
    const limit = limitFor(call.toolName)
    const arm = (ms: number): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        const asked = waitingOn()
        if (asked && Date.now() - startedAt < APPROVAL_WAIT_MAX_MS) {
          timer = arm(limit ?? READ_ONLY_TIMEOUT_MS)
          return
        }
        if (!asked && isShellTool(call.toolName)) {
          // The backend never answered: stop whatever it is still running.
          void stopBackendCall(ctx.sessionId, call.toolCallId)
        }
        const seconds = Math.round((limit ?? READ_ONLY_TIMEOUT_MS) / 1000)
        finish({
          output: asked
            ? `ERROR: ${call.toolName} did not run: it was waiting for the user's approval (${asked.toolName}) and the approval was never answered.`
            : isShellTool(call.toolName)
              ? `ERROR: ${call.toolName} timed out after ${seconds} seconds with no answer and was stopped; any process it started was killed. No result is available.`
              : `ERROR: ${call.toolName} timed out after ${seconds} seconds`,
          isError: true,
        })
      }, ms)
    let timer: ReturnType<typeof setTimeout> | undefined =
      limit !== undefined ? arm(limit) : undefined
    signal?.addEventListener('abort', stop, { once: true })
    void routeCoworkTool(call, ctx, signal).then(finish, (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unregisterStop()
      signal?.removeEventListener('abort', stop)
      reject(error)
    })
  })
}

/** Resolves `false` as soon as `signal` aborts, whatever `answer` does. */

/** Why a run's signal aborted, in words for the record. */

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
 * Start `run` as one of this run's background tasks and return its task id at
 * once. Shared by `task` and `workflow` with `background: true`, so a
 * background run is held, announced, awaited and stopped the same way.
 */
export function startBackgroundCall(
  call: PendingToolCall,
  ctx: Pick<DispatchContext, 'tasks' | 'trackSubagent' | 'cancelChild'> & {
    sessionId?: string
  },
  opts: {
    kind: 'subagent' | 'workflow'
    name: string
    run: () => Promise<ToolOutcome>
  }
): ToolOutcome {
  const { kind, name } = opts
  // Held for as long as the child lives, not just for this call: the
  // child inherits this run's authority until it is done.
  const childDone = ctx.trackSubagent?.()
  const id = call.toolCallId
  ctx.tasks!.start(
    id,
    name,
    async () => {
      try {
        const done = await opts.run()
        // Pushed to the parent at its next step boundary, so it need not
        // poll `task_status`. A stop the user asked for is not news.
        if (ctx.sessionId && !(done.isError && /cancelled/i.test(done.output))) {
          const preview = done.output.replace(/\s+/g, ' ').slice(0, 160)
          pushNotice(
            ctx.sessionId,
            `Background ${kind} '${name}' (task_id=${id}) ${done.isError ? 'failed' : 'finished'}: "${preview}". ` +
              'Read the full answer with await_task.'
          )
        }
        return done
      } catch (e) {
        if (ctx.sessionId) {
          pushNotice(
            ctx.sessionId,
            `Background ${kind} '${name}' (task_id=${id}) failed to run.`
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
      `${kind === 'workflow' ? 'Workflow' : 'Task'} started in the background. task_id=${id}${kind === 'workflow' ? ' (also its run_id for resume_run_id and control)' : ''}. Keep working; call await_task with this task_id to collect its ${kind === 'workflow' ? 'combined report' : 'answer'}, ` +
      'task_status to check on it, or cancel_task to stop it. The run waits for it before it ends.',
  }
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
    'tasks' | 'onTask' | 'onTeam' | 'trackSubagent' | 'cancelChild' | 'agentDefaults'
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
    const defaulted = applyTaskDefaults(
      call.input,
      ctx.agentDefaults?.(
        String((call.input as { subagent_name?: unknown } | null)?.subagent_name ?? '')
      ),
      { canBackground: Boolean(ctx.tasks), canIsolate: Boolean(ctx.onTeam) }
    )
    if ('error' in defaulted) return { output: `ERROR: ${defaulted.error}`, isError: true }
    call = { ...call, input: defaulted.input }
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
      const name =
        typeof taskInput.subagent_name === 'string'
          ? taskInput.subagent_name
          : 'subagent'
      return startBackgroundCall(call, ctx, {
        kind: 'subagent',
        name,
        run: () => ctx.onTask(call.toolCallId, call.input),
      })
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

/** A tool the client answers itself, without the backend. */
type ClientRoute = (
  call: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
) => Promise<ToolOutcome>

/** `team` and `workflow`: the parent's alone, holding its subagent slot while they run. */
async function routeTeamTool(
  call: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  const { toolName } = call
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
  let teamInput: unknown = call.input
  if (toolName === WORKFLOW_TOOL_NAME) {
    const op = (call.input as { control?: unknown } | null)?.control
    if (op !== undefined) return runWorkflowControl(ctx.sessionId, op)
    if ((call.input as { list_saved?: unknown } | null)?.list_saved === true) {
      return { output: await describeSaved() }
    }
    const resumed = await resolveWorkflowInput(ctx.sessionId, call.input)
    if ('error' in resumed) return { output: `ERROR: ${resumed.error}`, isError: true }
    const converted = workflowToTeamInput(resumed.input)
    if (typeof converted === 'string') {
      return { output: `ERROR: ${converted}`, isError: true }
    }
    // The run record keeps the phases as written (placeholders intact) and
    // the values they were filled from.
    teamInput = { ...converted, run: { ...converted.run, ...resumed.template } }
    // Gated on what will actually run: a resume names no phases itself.
    const declined = await gateWorkflowLaunch({ ...call, input: resumed.input }, ctx, signal)
    if (declined) return declined
  }
  const onTeam = ctx.onTeam
  const inputOf = call.input as Record<string, unknown> | null
  if (toolName === WORKFLOW_TOOL_NAME && inputOf?.background === true && ctx.tasks) {
    return startBackgroundCall(call, ctx, {
      kind: 'workflow',
      name: 'workflow',
      run: () => onTeam(call.toolCallId, teamInput),
    })
  }
  const teamDone = ctx.trackSubagent?.()
  try {
    return await ctx.onTeam(call.toolCallId, teamInput)
  } finally {
    teamDone?.()
  }
}

/** Entering or leaving the session worktree: the parent's alone. */
async function routeWorktreeTool(
  call: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  const { toolName } = call
  // A subagent shares its parent's session id: it must not move the
  // parent's write access.
  if (!ctx.onTeam) {
    return {
      output: 'You cannot change the session worktree. Do this work yourself.',
      isError: true,
    }
  }
  const worktree = {
    mode: ctx.mode,
    toolCallId: call.toolCallId,
    signal,
    onApprove: ctx.onApprove,
  }
  return toolName === ENTER_WORKTREE_TOOL_NAME
    ? await runEnterWorktree(ctx.sessionId, call.input, worktree)
    : await runExitWorktree(ctx.sessionId, call.input, worktree)
}

/** The tools the client answers itself, by name. Checked after the approval gate. */
export const CLIENT_ROUTES: Readonly<Record<string, ClientRoute>> = {
  [TODO_TOOL_NAME]: async (call, ctx) => ctx.onTodo(call.input),
  [ASK_TOOL_NAME]: async (call, ctx) => ctx.onAsk(call.toolCallId, call.input),
  [SPAWN_SESSION_TOOL_NAME]: async (call, ctx, signal) => {
    // A subagent's dispatcher has no team, and its session id is its parent's:
    // letting it through would start nested chats on the parent's behalf.
    if (!ctx.onTeam) {
      return {
        output: 'You cannot start a nested chat. Do this work yourself.',
        isError: true,
      }
    }
    return await runSpawnSession(ctx.sessionId, call.input, {
      mode: ctx.mode,
      toolCallId: call.toolCallId,
      signal,
      onApprove: ctx.onApprove,
    })
  },
  [ENTER_WORKTREE_TOOL_NAME]: routeWorktreeTool,
  [EXIT_WORKTREE_TOOL_NAME]: routeWorktreeTool,
  [ENABLE_TOOLS_NAME]: async (call, ctx) => {
    if (!ctx.onEnableTools) {
      return { output: 'There is nothing to enable here.', isError: true }
    }
    return ctx.onEnableTools(call.input)
  },
  [ANSWER_SUBAGENT_TOOL_NAME]: async (call, ctx) => {
    // The parent's side only: a child's dispatcher has no team.
    if (!ctx.onTeam) {
      return { output: 'You cannot answer subagent questions.', isError: true }
    }
    return answerSubagent(ctx.sessionId, call.input)
  },
  // `task` and the tools that manage its background children.
  [TASK_TOOL_NAME]: routeDelegationTool,
  ...Object.fromEntries([...BACKGROUND_TASK_TOOLS].map((name) => [name, routeDelegationTool])),
  [TEAM_TOOL_NAME]: routeTeamTool,
  [WORKFLOW_TOOL_NAME]: routeTeamTool,
}

function clientRouteFor(toolName: string): ClientRoute | undefined {
  return Object.prototype.hasOwnProperty.call(CLIENT_ROUTES, toolName)
    ? CLIENT_ROUTES[toolName]
    : undefined
}

/** What the backend call carries for this tool: scope, grants, actor, and the hooks a tool asks through. */
function backendOptionsFor(
  call: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
): Parameters<typeof executeAgentTool>[3] {
  const { toolName } = call
  return {
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
      : toolName === 'write' || toolName === 'edit'
        ? // Stopping the run withdraws the question about a flagged line.
          { signal }
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
  }
}

/** A backend refusal or failure, as the model should read it: offer a folder, guide a missing read, or explain a policy refusal. */
async function mapBackendFailure(
  error: string,
  resources: ToolOutcome['resources'],
  call: PendingToolCall,
  ctx: DispatchContext,
  signal: AbortSignal | undefined,
  readPath: string | null,
  priorMisses: number
): Promise<ToolOutcome> {
  const { toolName } = call
  // The model reached for a path outside the sandbox and nothing is
  // attached: that is the user's call, not a dead end to retry around.
  if (
    ctx.onNeedFolder &&
    !ctx.readOnlyFolder &&
    isOutsideWorkspaceError(error)
  ) {
    const attached = await unlessStopped(
      ctx
        .onNeedFolder({ toolName, detail: error, signal })
        .then((answer) => answer === 'attached'),
      signal
    ).catch(() => false)
    if (attached) {
      return {
        output:
          `${error}\n\nThe user attached a project folder in response. ` +
          'This run ends here and restarts with that folder, so repeat the ' +
          'request once it does.',
        isError: true,
        endsTurn: true,
        resources,
      }
    }
    return {
      output:
        `${error}\n\nThe user chose not to attach a folder. Do not ` +
        'retry this path; work from the sandbox, or say what you need.',
      isError: true,
      resources,
    }
  }
  if (readPath && isMissingPathError(error)) {
    ctx.readFailures?.set(readPath, priorMisses + 1)
    return {
      output: error + missingReadGuidance(readPath),
      isError: true,
      resources,
    }
  }
  return {
    output:
      ctx.mode === 'bypass' && isPolicyRefusal(error)
        ? bypassCannotOverride(error)
        : error,
    isError: true,
    resources,
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

  // Review only: the project folder is read-only, so PowerShell's default
  // working folder would be refused after the user allowed it. Say so before
  // asking, rather than offering an Allow that cannot succeed.
  const readOnlyCwd = reviewOnlyPowershellRefusal(call, ctx)
  if (readOnlyCwd) return readOnlyCwd

  // Stopping another session: asked every time, in every mode that offers it,
  // whatever grants exist; refused in review mode and where nothing can ask.
  if (toolName === STOP_SESSION_TOOL_NAME) {
    const refused = await gateStopSession(call, ctx, signal)
    if (refused) return refused
  }

  // Campaign tools: the coordinator's alone. `campaign_plan` puts its own
  // always-ask prompt to the user inside the handler.
  if (CAMPAIGN_TOOLS.has(toolName)) {
    if (!ctx.onCampaign) {
      return {
        output:
          `\`${toolName}\` is not available here: campaign tools belong to ` +
          'the coordinator session only.',
        isError: true,
      }
    }
    return ctx.onCampaign(call, signal)
  }

  // The approval policy: access, run mode, destructive and read-only shell
  // checks, saved rules and the prompt (see `cowork/approvalGate.ts`).
  const gated = await gateMutation(call, ctx, signal)
  if (gated.outcome) return gated.outcome
  call = gated.call
  const git = gated.git

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
    const client = clientRouteFor(toolName)
    if (client) return await client(call, ctx, signal)

    // Review mode changes nothing: a click or a keystroke can.
    if (isReviewDeniedTool(toolName) && isReadOnly(ctx.mode)) {
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

    // Another conversation the user mentioned: local, read-only, bounded.
    if (isChatReadTool(toolName)) {
      const read = await executeChatRead(
        call.input,
        chatReadContextForSession(ctx.sessionId)
      )
      return read.error !== undefined
        ? { output: read.error, isError: true }
        : { output: read.content ?? '' }
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

    // Bypass let this call through without a question: say so in the record,
    // so a run that asked nobody can be audited as one.
    if (
      ctx.mode === 'bypass' &&
      (PLAN_DENIED_TOOLS.has(toolName) ||
        git ||
        HOST_ASKED.has(toolName) ||
        toolName === 'request_access' ||
        isBrowserTool(toolName) ||
        toolName === BROWSER_TOOL_NAME)
    ) {
      await recordToolActivity({
        call: call.toolCallId,
        tool: toolName,
        session: ctx.sessionId,
        run: ctx.activity?.run ?? '',
        invocation: ctx.activity?.invocation ?? '',
        agent: ctx.activity?.agent ?? '',
        resource: resourceOf(call.input),
        phase: 'allowed',
        detail: AUTO_APPROVED_BYPASS,
      })
    }

    // Held for the length of the call, and released on every way out of it —
    // output, refusal or throw.
    const shellDone = toolName === 'bash' ? ctx.trackShell?.() : undefined
    let result
    try {
      // `'session'`, not the default `'thread'`: a Cowork session id lives in
      // its own namespace, and the thread sweep would otherwise delete this
      // sandbox because no chat thread claims it.
      result = await executeAgentTool(
        toolName,
        call.input,
        ctx.sessionId,
        backendOptionsFor(call, ctx, signal)
      )
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
      return await mapBackendFailure(result.error, result.resources, call, ctx, signal, readPath, priorMisses)
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
