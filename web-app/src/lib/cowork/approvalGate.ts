import { SCOPABLE_TOOLS, checkScopedRule } from '@/lib/approvalScopes'
import { executeAgentTool, previewAgentChange } from '@/lib/agentTools'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { destructiveCommandReason } from '@/lib/destructiveCommand'
import { isReadOnlyCommand } from '@/lib/readOnlyCommand'
import {
  noteAutoApproved,
  resetAutoApproveStreak,
  autoApprovePauseReason,
  useAutoApproveLimit,
} from '@/hooks/useAutoApproveLimit'
import { PLAN_DENIED_TOOLS } from '@/lib/coworkTools'
import {
  decideMutation,
  writesInsideSessionTree,
  BACKEND_ACCESS_CAPABILITY,
} from '@/lib/coworkAccess'
import type { PendingToolCall, ToolOutcome } from '@/lib/coworkRunner'
import { recordToolActivity, resourceOf } from '@/lib/toolActivity'
import {
  GIT_TOOL_NAME,
  gitApproval,
  gitInsideSessionTree,
  gitRemoteFacts,
} from '@/lib/gitTool'
import { attributeGitInput } from '@/lib/gitAttribution'
import type { DispatchContext } from '@/lib/coworkDispatch'

/**
 * Refusal text for a tool plan mode withholds.
 *
 * Withholding alone is not authoritative — a model can emit a call to a tool
 * that was never advertised, and the SDK still surfaces it — so the dispatcher
 * refuses by name too. The wording tells the model what to do instead, or it
 * simply retries.
 */
export function planRefusal(toolName: string): ToolOutcome {
  return {
    output:
      `The \`${toolName}\` tool is disabled in review mode, which is ` +
      'read-only. Finish investigating, stage the plan with the `todo` tool, ' +
      'then call `ask` for review.',
    isError: true,
  }
}

export function detachedRefusal(toolName: string): ToolOutcome {
  return {
    output:
      `The folder this session was working in is no longer attached, so ` +
      `\`${toolName}\` was not run. Stop, say what was done so far, and ` +
      'wait for the user to choose a folder again.',
    isError: true,
  }
}

export function skillRefusal(
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
 * The user was asked to allow this call and said no. Takes what the approval
 * card left for this call -- the reason typed with the deny, which the model is
 * told, and any command edit, which no longer applies -- so neither outlives it.
 */
export function deniedByUser(toolName: string, toolCallId?: string): ToolOutcome {
  const approvals = useToolApprovalRequests.getState()
  const reason = toolCallId ? approvals.takeRefusalReason?.(toolCallId) : undefined
  if (toolCallId) approvals.takeEditedInput?.(toolCallId)
  return {
    output:
      `The user did not allow \`${toolName}\`. Do not retry it. ` +
      (reason ? `Their reason: ${reason}. ` : '') +
      'Say what you would have changed, and wait for instructions.',
    isError: true,
  }
}

export function bypassNoted(
  outcome: ToolOutcome,
  ctx: Pick<DispatchContext, 'mode'>
): ToolOutcome {
  return ctx.mode === 'bypass'
    ? { ...outcome, output: bypassCannotOverride(outcome.output) }
    : outcome
}

/**
 * Why Bypass could not run a call, for the model and the person. Bypass skips
 * every question a person can answer; these refusals are not questions.
 */
export const bypassCannotOverride = (what: string): string =>
  `${what} Bypass skips approval prompts only, so it cannot override this.`

export function unlessStopped(
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

export function stopReason(signal: AbortSignal): string {
  const reason = signal.reason
  return typeof reason === 'string' && reason ? reason : 'cancelled'
}

/** Calls the user edited before allowing them, by call id: what actually ran. */
export const editedCalls = new Map<string, unknown>()

export type MutationGate = {
  /** Set when the gate answered the call itself (a refusal or a denial). */
  outcome?: ToolOutcome
  /** The call to run: attributed, and rewritten if the user edited a command. */
  call: PendingToolCall
  /** The parsed vcs plan, when the call is a `git` call. */
  git: ReturnType<typeof gitApproval> | null
}

/**
 * The approval policy for a call that can change something: access and run
 * mode, destructive and read-only shell checks, saved rules, and the prompt.
 * Moved out of `routeCoworkTool` unchanged. Resolves with an `outcome` when the
 * call must not run, otherwise with the call (and plan) to carry on with.
 */
export async function gateMutation(
  startCall: PendingToolCall,
  ctx: DispatchContext,
  signal?: AbortSignal
): Promise<MutationGate> {
  let call = startCall
  const { toolName } = call
  let gitPlan: ReturnType<typeof gitApproval> | null = null
  const run = async (): Promise<ToolOutcome | undefined> => {
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
            return bypassNoted(detachedRefusal(toolName), ctx)
          case 'unresolved-skill':
            return bypassNoted(skillRefusal(toolName, unresolved), ctx)
          case 'no-consent':
            return bypassNoted(
              {
                output:
                  `\`${toolName}\` was not run: editing this folder has not been ` +
                  'confirmed for this session. Ask the user to confirm it, or ' +
                  'work in the session workspace instead.',
                isError: true,
              },
              ctx
            )
          case 'unsupported-access':
            return {
              output: bypassCannotOverride(
                `\`${toolName}\` was not run: the selected access mode is not ` +
                  'available in this build, so nothing outside the session ' +
                  'workspace can be changed. Say so rather than working around it.'
              ),
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

      // A rule the person saved with "Always" -- one folder, one command prefix --
      // answers an ordinary prompt for a call it covers. Never a forced one (a
      // destructive command, a push, the pause after a long streak), and the
      // backend only reports a rule for a call its own gate would have prompted
      // for: a refusal or an asked-every-time call is never covered.
      const scopeRoot = ctx.worktreePath ?? ctx.readOnlyFolder
      const savedRule =
        ctx.mode !== 'bypass' &&
        needsApproval &&
        !forced &&
        scopeRoot &&
        SCOPABLE_TOOLS.has(toolName)
          ? await checkScopedRule(scopeRoot, toolName, call.input)
          : null
      if (savedRule) {
        await recordToolActivity({
          call: call.toolCallId,
          tool: toolName,
          session: ctx.sessionId,
          run: ctx.activity?.run ?? '',
          invocation: ctx.activity?.invocation ?? '',
          agent: ctx.activity?.agent ?? '',
          resource: resourceOf(call.input),
          phase: 'allowed',
          detail: `decided by saved approval rule ${savedRule.id}`,
        })
      }

      if (ctx.mode !== 'bypass' && (needsApproval || forced) && !savedRule) {
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
        // The person rewrote the shell command before allowing it once: run what
        // they approved, never the model's original. Only `bash` can be edited.
        const edited = allowed
          ? useToolApprovalRequests.getState().takeEditedInput?.(call.toolCallId)
          : undefined
        const runsEdited = edited !== undefined && toolName === 'bash'
        if (runsEdited) {
          call = { ...call, input: { ...(call.input as object), ...edited } }
          editedCalls.set(call.toolCallId, call.input)
        }
        await recordToolActivity({
          ...permission,
          phase: allowed ? 'allowed' : 'refused',
          ...(runsEdited
            ? { detail: 'allowed after the user edited the command' }
            : {}),
        })
        if (!allowed) return deniedByUser(toolName, call.toolCallId)
      }
    }
    return undefined
  }
  const outcome = await run()
  return { outcome, call, git: gitPlan }
}
