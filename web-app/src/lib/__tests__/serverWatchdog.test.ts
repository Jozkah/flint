import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  withTimeout,
  guardServerStart,
  OPERATION_TIMED_OUT_CODE,
  SERVER_START_WATCHDOG_MS,
} from '../utils'

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes through a value or error that arrives in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'late')).resolves.toBe(
      'ok'
    )
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000, 'late')
    ).rejects.toThrow('boom')
  })

  it('rejects with the timeout code when the promise never settles', async () => {
    vi.useFakeTimers()
    const race = withTimeout(new Promise<never>(() => {}), 5000, 'too slow')
    const assertion = expect(race).rejects.toMatchObject({
      message: 'too slow',
      code: OPERATION_TIMED_OUT_CODE,
    })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })
})

describe('guardServerStart', () => {
  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { core?: unknown }).core
  })

  it('returns the port when the start finishes in time', async () => {
    await expect(guardServerStart(Promise.resolve(1337))).resolves.toBe(1337)
  })

  it('tears the server down and rejects when the start hangs', async () => {
    vi.useFakeTimers()
    const stopServer = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { core?: unknown }).core = { api: { stopServer } }

    let finishLate: (port: number) => void = () => {}
    const hung = new Promise<number>((resolve) => {
      finishLate = resolve
    })
    const guarded = guardServerStart(hung)
    const assertion = expect(guarded).rejects.toMatchObject({
      code: OPERATION_TIMED_OUT_CODE,
    })
    await vi.advanceTimersByTimeAsync(SERVER_START_WATCHDOG_MS)
    await assertion
    expect(stopServer).toHaveBeenCalledTimes(1)

    // A start that completes after the deadline is stopped again.
    finishLate(1337)
    await vi.advanceTimersByTimeAsync(0)
    expect(stopServer).toHaveBeenCalledTimes(2)
  })
})
