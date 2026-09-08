/** AH-024/AH-025: what may be retried, and how long to wait. */
import { describe, expect, it } from 'vitest'
import {
  backoffDelay,
  classifyFailure,
  decideRetry,
  isRetryable,
  parseRetryAfter,
  waitFor,
} from '../runRetry'

describe('classification', () => {
  it('never retries something a second attempt cannot change', () => {
    expect(classifyFailure({ status: 401 })).toBe('auth')
    expect(classifyFailure({ status: 403 })).toBe('auth')
    expect(classifyFailure({ status: 400 })).toBe('invalid')
    expect(classifyFailure({ aborted: true })).toBe('cancelled')
    expect(
      classifyFailure({ message: 'The user did not allow `bash`.' })
    ).toBe('refused')
    expect(
      classifyFailure({ message: 'stale approval', status: 200 })
    ).toBe('refused')
    for (const failure of [
      'auth',
      'invalid',
      'refused',
      'cancelled',
      'deterministic',
      'unknown',
    ] as const) {
      expect(isRetryable(failure)).toBe(false)
    }
  })

  it('retries what a second attempt might actually fix', () => {
    expect(classifyFailure({ status: 503 })).toBe('transient')
    expect(classifyFailure({ status: 408 })).toBe('transient')
    expect(classifyFailure({ status: 429 })).toBe('rate-limited')
    // Nothing answered at all.
    expect(classifyFailure({ message: 'could not connect' })).toBe('transient')
    expect(isRetryable('transient')).toBe(true)
    expect(isRetryable('rate-limited')).toBe(true)
  })

  it('does not retry a tool that failed on its own terms', () => {
    // Same inputs, same workspace, same failure -- and twenty steps spent.
    expect(
      classifyFailure({ fromTool: true, message: 'no such file' })
    ).toBe('deterministic')
  })
})

describe('when to try again', () => {
  it("waits as long as the server asked, in either spelling", () => {
    const now = Date.parse('2026-09-08T10:00:00Z')
    expect(parseRetryAfter('120', now)).toBe(120_000)
    expect(parseRetryAfter('Tue, 08 Sep 2026 10:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('soon', now)).toBe(null)
    expect(parseRetryAfter(null, now)).toBe(null)
    // A date already past is not a negative wait.
    expect(parseRetryAfter('Tue, 08 Sep 2026 09:59:00 GMT', now)).toBe(0)
  })

  it('grows the wait and spreads it, so clients do not return in lockstep', () => {
    const highest = (attempt: number) =>
      backoffDelay({ attempt, random: () => 0.999 })
    expect(highest(1)).toBeLessThan(highest(2))
    expect(highest(2)).toBeLessThan(highest(3))
    // Full jitter: the same attempt can wait almost nothing.
    expect(backoffDelay({ attempt: 3, random: () => 0 })).toBe(0)
    // And never longer than the cap.
    expect(backoffDelay({ attempt: 50, random: () => 0.999 })).toBeLessThanOrEqual(
      30_000
    )
  })

  it("takes the server's own delay over its own schedule", () => {
    expect(backoffDelay({ attempt: 1, retryAfterMs: 4000, random: () => 0 })).toBe(
      4000
    )
  })

  it('gives up rather than trying forever', () => {
    const now = Date.now()
    const decision = decideRetry({
      facts: { status: 503 },
      attempt: 3,
      now,
      random: () => 0.5,
    })
    expect(decision).toEqual({ retry: false, reason: 'attempts-exhausted' })
  })

  it('reports why it will not retry, rather than just refusing', () => {
    const now = Date.now()
    expect(
      decideRetry({ facts: { status: 401 }, attempt: 1, now })
    ).toEqual({ retry: false, reason: 'auth' })
  })

  it('counts the next attempt so each one can carry its own identity', () => {
    const decision = decideRetry({
      facts: { status: 429, retryAfter: '2' },
      attempt: 1,
      now: Date.now(),
    })
    expect(decision).toMatchObject({ retry: true, attempt: 2, delayMs: 2000 })
  })
})

describe('waiting', () => {
  it('stops waiting when the run is stopped, and says so', async () => {
    const controller = new AbortController()
    const waited = waitFor(10_000, controller.signal)
    controller.abort()
    // False, so a caller cannot mistake a cancelled wait for a completed one
    // and try again anyway.
    expect(await waited).toBe(false)
  })

  it('does not start a wait a stopped run would only abandon', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await waitFor(10_000, controller.signal)).toBe(false)
  })

  it('completes an uninterrupted wait', async () => {
    expect(await waitFor(1, undefined)).toBe(true)
  })
})
