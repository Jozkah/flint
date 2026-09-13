/** AH-019/AH-021: how long a run may take, and how it ends. */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RUN_DEADLINE_MS,
  isExpired,
  operationSignal,
  remainingMs,
  restoreDeadline,
  startDeadline,
  terminalReason,
} from '../runDeadline'

describe('the run deadline', () => {
  const t0 = Date.parse('2026-09-08T10:00:00Z')

  it('counts wall-clock time, including what the run spent waiting', () => {
    const deadline = startDeadline(t0, 60_000)
    expect(remainingMs(deadline, t0 + 20_000)).toBe(40_000)
    expect(isExpired(deadline, t0 + 59_999)).toBe(false)
    expect(isExpired(deadline, t0 + 60_000)).toBe(true)
    expect(remainingMs(deadline, t0 + 90_000)).toBe(0)
  })

  it('is still spent when the app was closed for it', () => {
    const stored = startDeadline(t0, 60_000)
    const restored = restoreDeadline(stored, t0 + 120_000)
    expect(isExpired(restored!, t0 + 120_000)).toBe(true)
  })

  it('does not expire everything because the clock moved', () => {
    const stored = startDeadline(t0, 60_000)
    // The machine's clock jumped backwards a day.
    const restored = restoreDeadline(stored, t0 - 86_400_000)
    expect(restored!.budgetMs).toBe(60_000)
    expect(isExpired(restored!, t0 - 86_400_000)).toBe(false)
  })

  it('restores nothing from nothing', () => {
    expect(restoreDeadline(null, t0)).toBe(null)
    expect(restoreDeadline({ at: NaN, budgetMs: 1 }, t0)).toBe(null)
  })

  it('defaults to a budget that fits real work', () => {
    expect(DEFAULT_RUN_DEADLINE_MS).toBeGreaterThanOrEqual(10 * 60_000)
  })
})

describe('one operation', () => {
  it('stops when the operation runs too long', async () => {
    vi.useFakeTimers()
    const op = operationSignal(undefined, 1000)
    expect(op.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(op.signal.aborted).toBe(true)
    expect(op.timedOut()).toBe(true)
    op.dispose()
    vi.useRealTimers()
  })

  it('stops when the run itself is stopped, and does not call that a timeout', () => {
    const run = new AbortController()
    const op = operationSignal(run.signal, 60_000)
    run.abort()
    expect(op.signal.aborted).toBe(true)
    expect(op.timedOut()).toBe(false)
    op.dispose()
  })

  it('starts already stopped when the run is already stopped', () => {
    const run = new AbortController()
    run.abort()
    const op = operationSignal(run.signal, 60_000)
    expect(op.signal.aborted).toBe(true)
    expect(op.timedOut()).toBe(false)
  })

  it('leaves no timer behind once the operation finishes', () => {
    vi.useFakeTimers()
    const op = operationSignal(undefined, 1000)
    op.dispose()
    vi.advanceTimersByTime(5000)
    expect(op.signal.aborted).toBe(false)
    vi.useRealTimers()
  })
})

describe('how a run reports its ending', () => {
  it('reports exactly one reason, however many were true', () => {
    expect(terminalReason(['steps', 'deadline', 'error'])).toBe('deadline')
    expect(terminalReason(['aborted', 'timeout'])).toBe('aborted')
    expect(terminalReason(['tokens', 'steps'])).toBe('tokens')
    expect(terminalReason([null, undefined])).toBe('done')
    expect(terminalReason(['loop', 'steps'])).toBe('loop')
  })
})
