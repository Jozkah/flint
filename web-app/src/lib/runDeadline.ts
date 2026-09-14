/**
 * How long a run may take, and what happens when it has taken it. AH-019 /
 * AH-021.
 *
 * Two different limits, kept apart because they answer different questions.
 * The *deadline* bounds the whole run: an unattended agent must not still be
 * working an hour after the person who started it went home. The *timeout*
 * bounds one operation: a model stream that stops producing, a tool that never
 * returns, an MCP server that accepted a request and went quiet.
 *
 * Both are wall-clock, and both count the waiting. A run stuck for ten minutes
 * on a permission prompt nobody is going to answer has spent ten minutes,
 * whatever it was waiting for -- excluding waits would make the deadline a
 * measure of Flint's activity rather than of the user's time.
 */

/** A whole run. Generous: real work runs long. */
export const DEFAULT_RUN_DEADLINE_MS = 30 * 60_000

/** One model stream, tool call or MCP request. */
export const DEFAULT_OPERATION_TIMEOUT_MS = 10 * 60_000

export type Deadline = {
  /** Epoch millis. Absolute, so it survives a restart unchanged. */
  at: number
  /** What was allowed, for reporting how long it was. */
  budgetMs: number
}

export function startDeadline(
  now: number,
  budgetMs: number = DEFAULT_RUN_DEADLINE_MS
): Deadline {
  return { at: now + budgetMs, budgetMs }
}

export function remainingMs(deadline: Deadline, now: number): number {
  return Math.max(0, deadline.at - now)
}

export function isExpired(deadline: Deadline, now: number): boolean {
  return now >= deadline.at
}

/**
 * Restore a deadline that was persisted across a restart.
 *
 * A run whose deadline passed while the app was closed is expired, not
 * revived: the wall clock kept running, which is the whole point of a
 * wall-clock budget. But a deadline restored from a clock that has since moved
 * backwards -- a corrected system time, a machine resumed from sleep -- would
 * otherwise expire everything at once, so an implausible remainder is treated
 * as a fresh budget rather than an instant expiry.
 */
export function restoreDeadline(
  stored: Deadline | null | undefined,
  now: number
): Deadline | null {
  if (!stored || typeof stored.at !== 'number' || !Number.isFinite(stored.at)) {
    return null
  }
  const remaining = stored.at - now
  if (remaining > stored.budgetMs) {
    // More time left than was ever granted: the clock, not the run, is wrong.
    return startDeadline(now, stored.budgetMs)
  }
  return stored
}

/**
 * One operation's timeout, chained to the run's own signal.
 *
 * Returns a signal that aborts when either fires, so a tool cancelled by the
 * user and a tool that ran too long both stop the same way, and a caller
 * cannot accidentally honour one and not the other. `dispose` must be called
 * so a completed operation does not leave a timer behind.
 */
export function operationSignal(
  runSignal: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_OPERATION_TIMEOUT_MS
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timedOut = false

  if (runSignal?.aborted) {
    controller.abort(runSignal.reason)
    return {
      signal: controller.signal,
      dispose: () => {},
      timedOut: () => false,
    }
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`the operation took longer than ${timeoutMs}ms`))
  }, timeoutMs)

  const stop = () => controller.abort(runSignal?.reason)
  runSignal?.addEventListener('abort', stop, { once: true })

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      runSignal?.removeEventListener('abort', stop)
    },
    timedOut: () => timedOut,
  }
}

/**
 * Why a run ended, as one value.
 *
 * A run ends once. Two limits reached in the same moment still produce one
 * reason, in a fixed order of precedence, because a transcript that reports a
 * run as both timed out and over budget describes something that did not
 * happen.
 */
export type TerminalReason =
  | 'done'
  | 'aborted'
  | 'timeout'
  | 'deadline'
  | 'steps'
  | 'tokens'
  | 'context'
  | 'loop'
  | 'error'

const PRECEDENCE: TerminalReason[] = [
  'aborted',
  'deadline',
  'timeout',
  'loop',
  'context',
  'tokens',
  'steps',
  'error',
  'done',
]

/** The single reason to report, given everything that was true at the end. */
export function terminalReason(
  candidates: readonly (TerminalReason | null | undefined)[]
): TerminalReason {
  for (const reason of PRECEDENCE) {
    if (candidates.includes(reason)) return reason
  }
  return 'done'
}
