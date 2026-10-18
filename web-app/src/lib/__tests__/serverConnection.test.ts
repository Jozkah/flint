import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  checkServer,
  startServerConnectionMonitor,
  useServerConnection,
} from '../serverConnection'

const ok = () => new Response('ok', { status: 200 })

beforeEach(() => {
  useServerConnection.setState({ state: 'online', failures: 0 })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('server connection', () => {
  it('a refused or failed look is false, an answer is true', async () => {
    expect(await checkServer(async () => ok())).toBe(true)
    expect(await checkServer(async () => new Response('', { status: 502 }))).toBe(false)
    expect(
      await checkServer(async () => {
        throw new TypeError('Failed to fetch')
      })
    ).toBe(false)
  })

  it('goes offline after two failed looks and back online on the first answer', () => {
    const { report } = useServerConnection.getState()
    report(false)
    expect(useServerConnection.getState().state).toBe('online')
    report(false)
    expect(useServerConnection.getState().state).toBe('offline')
    report(true)
    expect(useServerConnection.getState()).toMatchObject({ state: 'online', failures: 0 })
  })

  it('the monitor marks a stopped server offline and clears it when it returns', async () => {
    vi.useFakeTimers()
    let up = false
    const fetchImpl = vi.fn(async () => {
      if (!up) throw new TypeError('Failed to fetch')
      return ok()
    })
    const stop = startServerConnectionMonitor({ fetchImpl, everyMs: 100, offlineEveryMs: 50 })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(50)
    expect(useServerConnection.getState().state).toBe('offline')
    up = true
    await vi.advanceTimersByTimeAsync(50)
    expect(useServerConnection.getState().state).toBe('online')
    stop()
    const calls = fetchImpl.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchImpl.mock.calls.length).toBe(calls)
  })
})
