/**
 * Stopping a run that has stopped getting anywhere. AH-029 / AH-030.
 *
 * A model that cannot make progress does not stop; it repeats. The shapes it
 * repeats in are recognisable -- the same call again, the same call spelled
 * differently, the same failure, an edit reverted and re-made, a subagent
 * delegating to a subagent -- and each of them will otherwise run to the step
 * budget, spending the user's time and tokens on nothing.
 *
 * The guard is not something the model can talk its way out of. It is counted
 * here, from what actually happened, and the run is stopped or paused whatever
 * the model says about it: a model in a loop is precisely the one most likely
 * to insist it is about to finish.
 */

export type LoopReason =
  /** The same call, byte for byte, more than the limit allows. */
  | 'repeated-call'
  /** The same call in a different spelling. */
  | 'equivalent-call'
  /** The same call failing the same way. */
  | 'repeated-failure'
  /** Edits that undo each other, leaving the file where it started. */
  | 'no-progress'
  /** A subagent delegating deeper than the run allows. */
  | 'recursive-delegation'
  /** Shell commands failing in a row for the same kind of reason. */
  | 'failing-shell'
  /** Too many failed shell commands in one run, whatever the reasons. */
  | 'shell-failure-budget'
  /** One tool failing call after call, whatever the arguments or errors. */
  | 'failing-tool'

export type LoopVerdict =
  | { tripped: false }
  | { tripped: true; reason: LoopReason; detail: string }

/**
 * How many times a shape may repeat before it counts as a loop.
 *
 * - `REPEAT_LIMIT` (5): the same call, successful or not. Five, not three:
 *   re-reading a file after editing it, or running the same test command twice
 *   while fixing it, is ordinary work, and a guard that stops ordinary work
 *   gets turned off.
 * - `FAILURE_LIMIT` (3): the same tool failing with the same error. A failure
 *   repeating is stronger evidence than a call repeating, so it gets fewer.
 * - `SHELL_STREAK_LIMIT` (3): consecutive failed shell commands that fail for
 *   the same kind of reason (a program that is not installed, access denied,
 *   a POSIX-only construct, the sandbox in the way), whatever the commands
 *   were. Probing for a missing program with ten spellings of the same idea
 *   is one loop, not ten different attempts.
 * - `SHELL_FAILURE_BUDGET` (8): failed shell commands in one run, for any
 *   reason. A run that has failed that often is guessing.
 */
export const REPEAT_LIMIT = 5
export const FAILURE_LIMIT = 3
export const SHELL_STREAK_LIMIT = 3
export const SHELL_FAILURE_BUDGET = 8
/**
 * Consecutive failed calls of one tool, whatever the arguments and whatever
 * the errors, before the run is stopped. A model trying a different command
 * against a tool that keeps refusing ("Command not whitelisted", then another
 * error, then another) changes its arguments every time, so neither the
 * same-call nor the same-error count ever trips; this does. A success of that
 * tool ends the streak; calls to other tools in between do not. The built-in
 * shell has its own, reason-aware counting above and is not counted here.
 */
export const TOOL_FAILURE_STREAK_LIMIT = 5
/**
 * The same refusal by Flint's own policy (a sandbox block, a path outside the
 * workspace, a permission denial) before the run is stopped. Higher than
 * `FAILURE_LIMIT`, and not counted toward the shell budget or the tool
 * streaks: a refusal is not the model guessing, and a model that meets a few
 * while looking for another way through was being stopped with every tool
 * disabled even when that other way existed.
 */
export const DENIAL_LIMIT = 6

const DENIED =
  /\[sandbox:|was refused|is denied|not permitted|outside the workspace|permission_denied|sandbox_denied|access (is )?denied|UnauthorizedAccess/i

/** Whether a failure is Flint (or the OS sandbox) refusing, not the call failing. */
export function isDenial(error: string | undefined): boolean {
  return !!error && DENIED.test(error)
}
export const NO_PROGRESS_LIMIT = 2
export const DELEGATION_DEPTH_LIMIT = 3

/** The shell tool's name, whose failures get the stricter counting. */
const SHELL_TOOL = 'bash'

/** Why a shell command failed, coarsely, so different commands can be compared. */
export type ShellFailureClass =
  | 'program not available'
  | 'needs a POSIX shell'
  | 'access denied'
  | 'blocked by the sandbox'

/**
 * The kind of reason a failed shell command gives, or null when it is not one
 * of the kinds that repeat without the model being able to change anything.
 */
export function classifyShellFailure(error: string | undefined): ShellFailureClass | null {
  if (!error) return null
  if (/needs a POSIX shell/i.test(error)) return 'needs a POSIX shell'
  if (
    /is not recognized as (the name of a cmdlet|an internal or external command)|command not found|CommandNotFoundException/i.test(
      error
    )
  ) {
    return 'program not available'
  }
  if (/access (is )?denied|permission denied|UnauthorizedAccess/i.test(error)) {
    return 'access denied'
  }
  if (/\[sandbox:/i.test(error)) return 'blocked by the sandbox'
  return null
}

/**
 * A blocker whose own output says that changing the spelling of the next call
 * cannot fix it. These get one opportunity for the model to change strategy,
 * then stop on the second encounter instead of spending the ordinary 5/6-call
 * retry budgets.
 */
export type StableFailureClass =
  | 'dirty git worktree'
  | 'access must change before retrying'

export function classifyStableFailure(
  tool: string,
  error: string | undefined
): StableFailureClass | null {
  if (!error) return null
  if (
    tool === 'git' &&
    /would be overwritten by (?:checkout|switch)|please commit your changes or stash them before you switch branches|untracked working tree files would be overwritten/i.test(
      error
    )
  ) {
    return 'dirty git worktree'
  }
  if (
    /do not retry (?:the )?(?:same )?(?:call|command).*?(?:until|before).*?(?:grant|permission|access)|do not retry .* before it is granted/i.test(
      error
    )
  ) {
    return 'access must change before retrying'
  }
  return null
}

/** Notes from the shell tool that already say retrying cannot help. */
const TOLD_NOT_TO_RETRY =
  /\[device_path:|cannot open it on this platform|reported exit 0, but|is installed at/i

/**
 * The null device refusing the sandbox. Not a dead end: Flint offers the user
 * an unsandboxed retry of the command, so it never counts toward the stop above.
 */
const NULL_DEVICE_REFUSED = /\[device_path_sandbox_refused:/i

export type ObservedCall = {
  tool: string
  input: unknown
  /** Set once the call has settled. */
  failed?: boolean
  /** The error text, so two different failures do not count as a repeat. */
  error?: string
  /** The path a write or edit touched, when it touched one. */
  path?: string
  /** The content it left behind, hashed by the caller or passed whole. */
  after?: string
  /** How deep in the subagent tree this call was made. */
  depth?: number
}

/**
 * A call's identity for comparison purposes.
 *
 * Key order and whitespace are not meaning: `{"path":"a","text":"x"}` and
 * `{ "text":"x", "path":"a" }` are the same call, and a model that alternates
 * between the two spellings is looping just as surely as one that does not.
 * Neither is a freshly minted id (see `VOLATILE_KEY`).
 *
 * This key is also the "no progress" rule: the same call reaching
 * `REPEAT_LIMIT` trips whether or not it succeeded, since a call that keeps
 * succeeding with the same arguments is not moving the turn forward either.
 */
export function canonicalKey(call: {
  tool: string
  input: unknown
}): string {
  return `${call.tool}::${canonicalJson(call.input)}`
}

/**
 * Values that are minted fresh for every call and carry no meaning of their
 * own: a UUID, or the value of a field whose name says it is a one-off handle
 * (`commandId`, `requestId`, a nonce). A model that approves command after
 * command, each with a new id, and runs the same command in between, is
 * repeating one call, not making a new one each time; so these are compared
 * as a placeholder. Ordinary ids (`issueId`, `path`) are left alone: stepping
 * through different issues is progress.
 */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const VOLATILE_KEY =
  /^(command_?id|request_?id|call_?id|tool_?call_?id|approval_?id|nonce|idempotency_?key|correlation_?id|trace_?id|token|uuid)$/i
const VOLATILE = '<id>'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string'
      ? value.trim().replace(UUID_PATTERN, VOLATILE)
      : JSON.stringify(value) ?? ''
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((key) =>
      VOLATILE_KEY.test(key) && record[key] != null && typeof record[key] !== 'object'
        ? `${key}:${VOLATILE}`
        : `${key}:${canonicalJson(record[key])}`
    )
    .join(',')}}`
}

/**
 * A non-transient blocker may have different arguments or slightly different
 * OS text each time. Count the semantic blocker instead of waiting for five
 * byte-identical calls. The first failure is still returned to the model so it
 * can choose a genuinely different strategy.
 */
function stableFailureRepeat(calls: ObservedCall[]): LoopVerdict | null {
  const counts = new Map<string, number>()
  for (const call of calls) {
    if (!call.failed) continue
    const stable = classifyStableFailure(call.tool, call.error)
    if (!stable) continue
    const key = `${call.tool}:${stable}`
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count >= 2) {
      return {
        tripped: true,
        reason: call.tool === SHELL_TOOL ? 'failing-shell' : 'failing-tool',
        detail: `${call.tool} hit the same non-transient blocker twice (${stable})`,
      }
    }
  }
  return null
}

/**
 * Whether the run has stopped making progress.
 *
 * Takes the whole history rather than being fed one call at a time, so the
 * guard has no state of its own to get out of step with the run -- and so it
 * gives the same verdict when it is re-checked after a restart.
 */
export function detectLoop(calls: ObservedCall[]): LoopVerdict {
  if (calls.length === 0) return { tripped: false }

  // Recursive delegation, checked first: it is the shape that multiplies
  // rather than merely repeats.
  const deepest = calls.reduce((max, call) => Math.max(max, call.depth ?? 0), 0)
  if (deepest >= DELEGATION_DEPTH_LIMIT) {
    return {
      tripped: true,
      reason: 'recursive-delegation',
      detail: `delegation reached depth ${deepest}`,
    }
  }

  const stable = stableFailureRepeat(calls)
  if (stable) return stable

  const exact = new Map<string, number>()
  const failures = new Map<string, number>()
  for (const call of calls) {
    const key = canonicalKey(call)
    const seen = (exact.get(key) ?? 0) + 1
    exact.set(key, seen)
    if (seen >= REPEAT_LIMIT) {
      // Identical spelling and canonically equivalent spelling are counted by
      // the same key on purpose: to the workspace they are the same call.
      const spellings = new Set(
        calls
          .filter((one) => canonicalKey(one) === key)
          .map((one) => JSON.stringify(one.input))
      )
      return {
        tripped: true,
        reason: spellings.size > 1 ? 'equivalent-call' : 'repeated-call',
        detail: `${call.tool} called ${seen} times with the same arguments`,
      }
    }

    if (call.failed) {
      // Keyed on the tool and the error, not the arguments: a model that
      // tries `foo 1`, `foo 2` and `foo 3` and is told "command not found"
      // every time is in the same loop as one that repeats a single call, and
      // changing a digit each round should not buy it another attempt.
      const failureKey = `${call.tool}::${call.error ?? ''}`
      const count = (failures.get(failureKey) ?? 0) + 1
      failures.set(failureKey, count)
      if (count >= (isDenial(call.error) ? DENIAL_LIMIT : FAILURE_LIMIT)) {
        const kind =
          call.tool === SHELL_TOOL ? classifyShellFailure(call.error) : null
        const inputs = new Set(
          calls
            .filter(
              (one) => one.failed && `${one.tool}::${one.error ?? ''}` === failureKey
            )
            .map((one) => canonicalKey(one))
        )
        return {
          tripped: true,
          reason: 'repeated-failure',
          // "The same way" only when it was the same call: different commands
          // failing alike are the same *reason*, not the same attempt.
          detail:
            inputs.size <= 1
              ? `${call.tool} failed ${count} times the same way`
              : kind
                ? `${call.tool} failed ${count} times for the same reason (${kind})`
                : `${call.tool} failed ${count} times with the same error`,
        }
      }
    }
  }

  const shell = shellFailures(calls)
  if (shell) return shell

  const failing = toolFailureStreak(calls)
  if (failing) return failing

  const churn = noProgressCycle(calls)
  if (churn) return churn

  return { tripped: false }
}

/**
 * Failed shell commands, counted by kind of reason rather than by text.
 *
 * A successful shell command ends a streak; calls to other tools in between
 * (reading a file to see why) do not.
 */
function shellFailures(calls: ObservedCall[]): LoopVerdict | null {
  let total = 0
  let streakClass: ShellFailureClass | null = null
  let streak = 0
  // Failures Flint already told the model not to retry (a device path, a
  // granted folder the shell cannot open, a masked exit code). The null device
  // refusing the sandbox is not one: the user is offered an unsandboxed retry. A second one means the note was
  // not heeded; waiting for the ordinary streak spent three more commands.
  let told = 0
  for (const call of calls) {
    if (call.tool !== SHELL_TOOL) continue
    if (!call.failed) {
      streakClass = null
      streak = 0
      continue
    }
    if (
      call.error &&
      TOLD_NOT_TO_RETRY.test(call.error) &&
      !NULL_DEVICE_REFUSED.test(call.error)
    ) {
      told += 1
      if (told >= 2) {
        return {
          tripped: true,
          reason: 'failing-shell',
          detail: `${call.tool} failed again after being told the sandbox cannot run it`,
        }
      }
    }
    // Refusals are counted, the same one alone, by the check above.
    if (isDenial(call.error)) continue
    total += 1
    if (total >= SHELL_FAILURE_BUDGET) {
      return {
        tripped: true,
        reason: 'shell-failure-budget',
        detail: `${total} shell commands failed in this run`,
      }
    }
    const kind = classifyShellFailure(call.error)
    if (kind && kind === streakClass) {
      streak += 1
    } else {
      streakClass = kind
      streak = kind ? 1 : 0
    }
    if (streakClass && streak >= SHELL_STREAK_LIMIT) {
      return {
        tripped: true,
        reason: 'failing-shell',
        detail: `${call.tool} failed ${streak} times in a row for the same reason (${streakClass})`,
      }
    }
  }
  return null
}

/** One tool failing again and again in a row, however its calls differ. */
function toolFailureStreak(calls: ObservedCall[]): LoopVerdict | null {
  const streaks = new Map<string, number>()
  for (const call of calls) {
    if (call.tool === SHELL_TOOL || call.failed === undefined) continue
    if (call.failed && isDenial(call.error)) continue
    if (!call.failed) {
      streaks.delete(call.tool)
      continue
    }
    const streak = (streaks.get(call.tool) ?? 0) + 1
    streaks.set(call.tool, streak)
    if (streak >= TOOL_FAILURE_STREAK_LIMIT) {
      return {
        tripped: true,
        reason: 'failing-tool',
        detail: `${call.tool} failed ${streak} times in a row`,
      }
    }
  }
  return null
}

/**
 * Edits that put a file back where it already was.
 *
 * Two writes to one path whose results alternate between the same two states
 * is a model arguing with itself. Counting writes alone would flag a file
 * being built up in steps, which is ordinary work.
 */
function noProgressCycle(calls: ObservedCall[]): LoopVerdict | null {
  const byPath = new Map<string, string[]>()
  for (const call of calls) {
    if (!call.path || call.after == null) continue
    const states = byPath.get(call.path) ?? []
    states.push(call.after)
    byPath.set(call.path, states)
  }

  for (const [path, states] of byPath) {
    if (states.length < NO_PROGRESS_LIMIT * 2) continue
    let reverts = 0
    for (let i = 2; i < states.length; i++) {
      // The file returned to a state it was already in.
      if (states[i] === states[i - 2]) reverts += 1
    }
    if (reverts >= NO_PROGRESS_LIMIT) {
      return {
        tripped: true,
        reason: 'no-progress',
        detail: `${path} was returned to an earlier state ${reverts} times`,
      }
    }
  }
  return null
}

/** What to tell the model when the guard stops a run. */
export function loopStopMessage(verdict: LoopVerdict & { tripped: true }): string {
  return (
    `Stopped: ${verdict.detail}. This is not making progress. ` +
    'Say what you were trying to do and what is in the way, and wait for ' +
    'instructions rather than trying again.'
  )
}

/**
 * What the user reads under the "stopped for repeating itself" notice when the
 * guard ends a Cowork run. Written to the user, not the model: the
 * model-directed wording of `loopStopMessage` ("Say what you were trying to
 * do... and wait for instructions") read as if Flint were asking the user to
 * explain themselves. The model gets its own note on the last tool result.
 */
export function loopStopNotice(verdict: LoopVerdict & { tripped: true }): string {
  const detail = verdict.detail.charAt(0).toUpperCase() + verdict.detail.slice(1)
  return (
    `${detail}, so Flint stopped the run. The last reply says what it was ` +
    'trying to do and what got in the way. Answer it, or change the request, ' +
    'to carry on.'
  )
}

/**
 * The note the model gets for its one last, tool-less turn after the guard
 * stops a run, so the user hears from it instead of the run just ending.
 */
export function loopFinalTurnNote(verdict: LoopVerdict & { tripped: true }): string {
  return (
    `[Flint stopped tool use: ${verdict.detail}. No more tools can run in this ` +
    'turn.] Reply to the user in plain text: say what you tried, what is ' +
    'blocking it, and what they could do (for example a command to run ' +
    'themselves). Do not call any tools.'
  )
}