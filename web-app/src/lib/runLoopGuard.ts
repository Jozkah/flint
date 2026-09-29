/**
 * Deterministic run-loop detection shared by Chat and Cowork.
 *
 * This guard is intentionally based on observed tool calls rather than model
 * narration. If the history shows that a run is repeating work, repeatedly
 * hitting a blocker, or inching through one file in tiny windows, the harness
 * stops tool use before the step budget is wasted.
 */

export type LoopReason =
  | 'repeated-call'
  | 'equivalent-call'
  | 'repeated-failure'
  | 'progressive-read'
  | 'no-progress'
  | 'recursive-delegation'
  | 'failing-shell'
  | 'shell-failure-budget'
  | 'failing-tool'

export type LoopVerdict =
  | { tripped: false }
  | { tripped: true; reason: LoopReason; detail: string }

export const REPEAT_LIMIT = 5
export const FAILURE_LIMIT = 3
export const SHELL_STREAK_LIMIT = 3
export const SHELL_FAILURE_BUDGET = 8
export const TOOL_FAILURE_STREAK_LIMIT = 5
export const DENIAL_LIMIT = 6
export const NO_PROGRESS_LIMIT = 2
export const DELEGATION_DEPTH_LIMIT = 3

/**
 * Four adjacent tiny reads, or four reads that keep the same start and reveal
 * only a few more lines each time, is not useful pagination. Both patterns were
 * observed in real transcripts and can consume dozens of turns while rereading
 * almost all of the same text.
 */
export const PROGRESSIVE_READ_LIMIT = 4
export const TINY_READ_MAX_LINES = 32
export const READ_EXPANSION_MAX_STEP = 32

const SHELL_TOOL = 'bash'
const DENIED =
  /\[sandbox:|was refused|is denied|not permitted|outside the workspace|permission_denied|sandbox_denied|access (is )?denied|UnauthorizedAccess/i

export function isDenial(error: string | undefined): boolean {
  return !!error && DENIED.test(error)
}

export type ShellFailureClass =
  | 'program not available'
  | 'needs a POSIX shell'
  | 'access denied'
  | 'blocked by the sandbox'

export function classifyShellFailure(
  error: string | undefined
): ShellFailureClass | null {
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

export type StableFailureClass =
  | 'dirty git worktree'
  | 'access must change before retrying'
  | 'pull request base changed'
  | 'pull request head is not pushed'
  | 'pull request has conflicts'
  | 'tool is unavailable'

/**
 * Failures whose text already says that repeating the operation cannot help.
 *
 * These are intentionally semantic rather than exact-output matches: the
 * transcript showed the same blocker with different commands (`npm`, `npm.cmd`,
 * direct node), and Git PR attempts with different argument spellings. The
 * strategy needs external state to change first, so two occurrences are enough
 * to stop burning the run budget.
 */
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
    tool === 'git' &&
    /pull request not opened: base .* has moved|fetch the target repository'?s current base branch before opening the pull request/i.test(
      error
    )
  ) {
    return 'pull request base changed'
  }
  if (
    tool === 'git' &&
    /pull request not opened: could not read pushed head|push the branch first/i.test(
      error
    )
  ) {
    return 'pull request head is not pushed'
  }
  if (
    tool === 'git' &&
    /pull request not opened: the proposed pull request does not merge cleanly|merge-tree .* exited with 1|resolve reported conflicts first/i.test(
      error
    )
  ) {
    return 'pull request has conflicts'
  }
  if (
    /model tried to call unavailable tool|tool ['`][^'`]+['`] is not available to this run|tool ['`][^'`]+['`] is disabled/i.test(
      error
    )
  ) {
    return 'tool is unavailable'
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

const TOLD_NOT_TO_RETRY =
  /\[device_path:|cannot open it on this platform|reported exit 0, but|is installed at/i
const NULL_DEVICE_REFUSED = /\[device_path_sandbox_refused:/i

export type ObservedCall = {
  tool: string
  input: unknown
  failed?: boolean
  error?: string
  path?: string
  after?: string
  depth?: number
}

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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((key) =>
      VOLATILE_KEY.test(key) &&
      record[key] != null &&
      typeof record[key] !== 'object'
        ? `${key}:${VOLATILE}`
        : `${key}:${canonicalJson(record[key])}`
    )
    .join(',')}}`
}

export function canonicalKey(call: { tool: string; input: unknown }): string {
  return `${call.tool}::${canonicalJson(call.input)}`
}

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

type ReadWindow = { path: string; offset: number; limit: number }

function readWindow(call: ObservedCall): ReadWindow | null {
  if (!/(^|[.:_-])read$/i.test(call.tool)) return null
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) {
    return null
  }
  const input = call.input as Record<string, unknown>
  if (typeof input.path !== 'string' || input.path.trim() === '') return null
  if (
    typeof input.offset !== 'number' ||
    !Number.isInteger(input.offset) ||
    input.offset < 0 ||
    typeof input.limit !== 'number' ||
    !Number.isInteger(input.limit) ||
    input.limit <= 0
  ) {
    return null
  }
  return { path: input.path.trim(), offset: input.offset, limit: input.limit }
}

/** Detect tiny adjacent pages and same-start windows that expand a few lines at a time. */
function progressiveReadLoop(calls: ObservedCall[]): LoopVerdict | null {
  let previous: ReadWindow | null = null
  let adjacentStreak = 0
  let expandingStreak = 0

  for (const call of calls) {
    const current = readWindow(call)
    if (!current) {
      previous = null
      adjacentStreak = 0
      expandingStreak = 0
      continue
    }

    const sameFile = previous?.path === current.path
    const adjacentTiny = Boolean(
      previous &&
        sameFile &&
        previous.limit <= TINY_READ_MAX_LINES &&
        current.limit <= TINY_READ_MAX_LINES &&
        current.offset === previous.offset + previous.limit
    )
    const creepingExpansion = Boolean(
      previous &&
        sameFile &&
        current.offset === previous.offset &&
        current.limit > previous.limit &&
        current.limit - previous.limit <= READ_EXPANSION_MAX_STEP
    )

    adjacentStreak = adjacentTiny ? adjacentStreak + 1 : 1
    expandingStreak = creepingExpansion ? expandingStreak + 1 : 1
    previous = current

    if (adjacentStreak >= PROGRESSIVE_READ_LIMIT) {
      return {
        tripped: true,
        reason: 'progressive-read',
        detail:
          `read paged through ${current.path} in ${adjacentStreak} consecutive tiny windows; ` +
          'search first or read one larger range instead',
      }
    }
    if (expandingStreak >= PROGRESSIVE_READ_LIMIT) {
      return {
        tripped: true,
        reason: 'progressive-read',
        detail:
          `read repeatedly reopened ${current.path} at line ${current.offset} while increasing the limit only slightly; ` +
          'advance past what was already read or request one useful range instead',
      }
    }
  }
  return null
}

export function detectLoop(calls: ObservedCall[]): LoopVerdict {
  if (calls.length === 0) return { tripped: false }

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

  const tinyReads = progressiveReadLoop(calls)
  if (tinyReads) return tinyReads

  const exact = new Map<string, number>()
  const failures = new Map<string, number>()
  for (const call of calls) {
    const key = canonicalKey(call)
    const seen = (exact.get(key) ?? 0) + 1
    exact.set(key, seen)
    if (seen >= REPEAT_LIMIT) {
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

    if (!call.failed) continue
    const failureKey = `${call.tool}::${call.error ?? ''}`
    const count = (failures.get(failureKey) ?? 0) + 1
    failures.set(failureKey, count)
    if (count < (isDenial(call.error) ? DENIAL_LIMIT : FAILURE_LIMIT)) continue

    const kind = call.tool === SHELL_TOOL ? classifyShellFailure(call.error) : null
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
      detail:
        inputs.size <= 1
          ? `${call.tool} failed ${count} times the same way`
          : kind
            ? `${call.tool} failed ${count} times for the same reason (${kind})`
            : `${call.tool} failed ${count} times with the same error`,
    }
  }

  return (
    shellFailures(calls) ??
    toolFailureStreak(calls) ??
    noProgressCycle(calls) ??
    { tripped: false }
  )
}

function shellFailures(calls: ObservedCall[]): LoopVerdict | null {
  let total = 0
  let streakClass: ShellFailureClass | null = null
  let streak = 0
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
    if (kind && kind === streakClass) streak += 1
    else {
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
    for (let i = 2; i < states.length; i += 1) {
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

export function loopStopMessage(
  verdict: LoopVerdict & { tripped: true }
): string {
  return (
    `Stopped: ${verdict.detail}. This is not making progress. ` +
    'Say what you were trying to do and what is in the way, and wait for ' +
    'instructions rather than trying again.'
  )
}

export function loopStopNotice(
  verdict: LoopVerdict & { tripped: true }
): string {
  const detail = verdict.detail.charAt(0).toUpperCase() + verdict.detail.slice(1)
  return (
    `${detail}, so Flint stopped the run. The last reply says what it was ` +
    'trying to do and what got in the way. Answer it, or change the request, ' +
    'to carry on.'
  )
}

export function loopFinalTurnNote(
  verdict: LoopVerdict & { tripped: true }
): string {
  return (
    `[Flint stopped tool use: ${verdict.detail}. No more tools can run in this ` +
    'turn.] Reply to the user in plain text: say what you tried, what is ' +
    'blocking it, and what they could do (for example a command to run ' +
    'themselves). Do not call any tools.'
  )
}
