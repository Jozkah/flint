/**
 * What may be retried, and how long to wait. AH-024 / AH-025.
 *
 * Classification is separate from the decision to retry, because they answer
 * different questions and get them wrong in different ways. A 401 is not
 * transient however many times it is tried; a refusal the user gave is not a
 * failure at all; and a tool that failed deterministically will fail
 * identically on the next attempt while looking like progress.
 *
 * Nothing here retries by itself. It says whether an attempt is eligible and
 * how long to wait; the caller owns the loop and the cancellation.
 */

export type FailureClass =
  /** The endpoint or network faltered and may not next time. */
  | 'transient'
  /** The endpoint asked for a specific wait before the next attempt. */
  | 'rate-limited'
  /** A credential or a permission. Retrying re-sends the same rejection. */
  | 'auth'
  /** The request itself was wrong. The next identical one is wrong too. */
  | 'invalid'
  /** A policy or the user said no. Retrying would be working around them. */
  | 'refused'
  /** Someone stopped the work. Not a failure to recover from. */
  | 'cancelled'
  /** A tool that failed on its own terms, deterministically. */
  | 'deterministic'
  /** Nothing here recognized it. Treated as not retryable. */
  | 'unknown'

export type FailureFacts = {
  status?: number | null
  /** `Retry-After`, verbatim: either seconds or an HTTP date. */
  retryAfter?: string | null
  message?: string | null
  /** Set when the failure came from a tool rather than the model endpoint. */
  fromTool?: boolean
  aborted?: boolean
}

const REFUSAL_MARKERS = [
  'did not allow',
  'was not run',
  'refused',
  'not permitted',
  'stale approval',
]

/** What kind of failure this is. Never a guess dressed as a fact. */
export function classifyFailure(facts: FailureFacts): FailureClass {
  if (facts.aborted) return 'cancelled'

  const message = (facts.message ?? '').toLowerCase()
  if (REFUSAL_MARKERS.some((marker) => message.includes(marker))) {
    return 'refused'
  }

  const status = facts.status ?? null
  if (status != null) {
    if (status === 401 || status === 403) return 'auth'
    if (status === 408 || status === 425) return 'transient'
    if (status === 429) return 'rate-limited'
    if (status === 409 || status === 423) return 'transient'
    if (status >= 500) return 'transient'
    if (status >= 400) return 'invalid'
    return 'unknown'
  }

  // A tool that ran and reported a failure will report it again: the inputs
  // and the workspace are the same. Retrying it is how a run spends twenty
  // steps doing nothing.
  if (facts.fromTool) return 'deterministic'

  // No status at all means nothing answered -- a connect failure, a dropped
  // stream. That is the case retrying exists for.
  if (message) return 'transient'
  return 'unknown'
}

export function isRetryable(failure: FailureClass): boolean {
  return failure === 'transient' || failure === 'rate-limited'
}

export const MAX_ATTEMPTS = 3
export const BASE_DELAY_MS = 500
export const MAX_DELAY_MS = 30_000

/**
 * Parse `Retry-After`, which is either a number of seconds or an HTTP date.
 *
 * `now` is passed in rather than read, so the date branch is testable and the
 * function has no clock of its own.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number
): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/**
 * How long before attempt number `attempt` (1 is the first retry).
 *
 * Exponential with full jitter, because a fleet of clients backing off in
 * lockstep re-creates the overload it is backing off from. `random` is a
 * parameter so the spread is testable rather than incidental.
 *
 * A server that named its own delay outranks the schedule: it knows when it
 * will be ready and Flint does not.
 */
export function backoffDelay(input: {
  attempt: number
  retryAfterMs?: number | null
  random?: () => number
}): number {
  if (input.retryAfterMs != null && input.retryAfterMs >= 0) {
    return Math.min(MAX_DELAY_MS, input.retryAfterMs)
  }
  const random = input.random ?? Math.random
  const ceiling = Math.min(
    MAX_DELAY_MS,
    BASE_DELAY_MS * 2 ** Math.max(0, input.attempt - 1)
  )
  return Math.floor(random() * ceiling)
}

export type RetryDecision =
  | { retry: true; delayMs: number; attempt: number }
  | { retry: false; reason: FailureClass | 'attempts-exhausted' }

/**
 * Whether to try again, and after how long.
 *
 * `attempt` is the number of attempts already made, so the first failure
 * arrives as 1.
 */
export function decideRetry(input: {
  facts: FailureFacts
  attempt: number
  maxAttempts?: number
  now: number
  random?: () => number
}): RetryDecision {
  const failure = classifyFailure(input.facts)
  if (!isRetryable(failure)) return { retry: false, reason: failure }

  const maxAttempts = input.maxAttempts ?? MAX_ATTEMPTS
  if (input.attempt >= maxAttempts) {
    return { retry: false, reason: 'attempts-exhausted' }
  }

  return {
    retry: true,
    attempt: input.attempt + 1,
    delayMs: backoffDelay({
      attempt: input.attempt,
      retryAfterMs: parseRetryAfter(input.facts.retryAfter, input.now),
      random: input.random,
    }),
  }
}

/**
 * Wait, unless the run is stopped first.
 *
 * Resolves `false` when the wait was cut short, so a caller cannot mistake a
 * cancellation for a completed backoff and try again anyway.
 */
export function waitFor(
  delayMs: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve(true)
    }, delayMs)
    const stop = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}
