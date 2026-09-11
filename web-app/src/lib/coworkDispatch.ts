import { executeAgentTool, previewAgentChange } from '@/lib/agentTools'
import {
  ASK_TOOL_NAME,
  PLAN_DENIED_TOOLS,
  TASK_TOOL_NAME,
  TEAM_TOOL_NAME,
  TODO_TOOL_NAME,
} from '@/lib/coworkTools'
import { isReadOnly, type CoworkMode } from '@/lib/coworkMode'
import {
  isMissingPathError,
  missingReadGuidance,
  planReviewRequest,
} from '@/lib/coworkPlanReview'
import {
  BACKEND_ACCESS_CAPABILITY,
  decideMutation,
  type AccessCapability,
  type AccessMode,
  type EditConsent,
} from '@/lib/coworkAccess'
import type { PendingToolCall, ToolOutcome } from '@/lib/coworkRunner'
import {
  recordToolActivity,
  resourceOf,
  withToolActivity,
  type ToolActivityContext,
} from '@/lib/toolActivity'
import { WEB_TOOL_NAMES, executeWebTool } from '@/lib/webSearchTool'

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
    input: unknown,
    /** The diff the call would make, when it changes a file. AH-146. */
    preview?: string,
    /** The run's signal: stopping the run withdraws the prompt. */
    signal?: AbortSignal
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
  unresolvedSkills?: readonly { requested: string; state: string }[]
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
  /** Runs a nested subagent to completion. */
  onTask: (toolCallId: string, input: unknown) => Promise<ToolOutcome>
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
  unresolved: readonly { requested: string; state: string }[]
): ToolOutcome {
  const named = unresolved
    .map((skill) => `${skill.requested} (${skill.state})`)
    .join(', ')
  return {
    output:
      `\`${toolName}\` was not run: you were asked to use ${named}, and ` +
      'that is not in effect. Do not work around it. Say which skill is ' +
      'unavailable and what the user can do about it, then stop.',
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
  const blocks = owed
    .map((one) =>
      [
        `<project_instructions path="${one.scope}/${one.name}" applies_to="${one.scope}/">`,
        one.content.trim(),
        '</project_instructions>',
      ].join('\n')
    )
    .join('\n\n')

  return {
    output:
      `\`${toolName}\` was not run yet: \`${path}\` is under a directory with ` +
      'its own instructions, which you had not been given. They are below, ' +
      'they apply to everything under that directory, and they rank below ' +
      '`JAN.md` and this system prompt where they disagree. Read them, then ' +
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
  return withToolActivity(
    call,
    { session: ctx.sessionId, run: '', ...(ctx.activity ?? {}) },
    signal,
    () => routeCoworkTool(call, ctx, signal)
  )
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
 * Route one tool call. Always resolves: a rejection here would abort the run,
 * where the model can usually recover from being told what went wrong.
 */
async function routeCoworkTool(
  call: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  const { toolName } = call

  // Every mutating call goes through the one policy, so the run mode and the
  // access mode cannot be answered differently in different places.
  if (PLAN_DENIED_TOOLS.has(toolName)) {
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

    if (decision.needsApproval) {
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
                scope: 'session',
                writeGrant: ctx.writeGrant,
              })
            : undefined
        allowed = await unlessStopped(
          ctx.onApprove(
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
    if (toolName === TASK_TOOL_NAME) {
      const childDone = ctx.trackSubagent?.()
      try {
        return await ctx.onTask(call.toolCallId, call.input)
      } finally {
        childDone?.()
      }
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
        scope: 'session',
        writeGrant: ctx.writeGrant,
        // The run the change belongs to, so it can be undone from it (AH-202).
        undoRun: ctx.activity?.run,
      })
    } finally {
      shellDone?.()
    }
    if (result.error) {
      if (readPath && isMissingPathError(result.error)) {
        ctx.readFailures?.set(readPath, priorMisses + 1)
        return {
          output: result.error + missingReadGuidance(readPath),
          isError: true,
        }
      }
      return { output: result.error, isError: true }
    }
    // A path that reads now is not missing any more.
    if (readPath) ctx.readFailures?.delete(readPath)
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
