import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PersistStorage } from 'zustand/middleware'
import { deferredPersistStorage, flushDeferredStores } from '../deferredPersistStorage'

type S = { n: number }
const v = (n: number) => ({ state: { n }, version: 0 })
const innerOf = (setItem: ReturnType<typeof vi.fn>) =>
  ({ getItem: vi.fn(), setItem, removeItem: vi.fn() }) as unknown as PersistStorage<S>

describe('deferredPersistStorage failures and idle delay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a rejected write is re-queued and retried, not lost or unhandled', async () => {
    const setItem = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValue(undefined)
    const s = deferredPersistStorage<S>(innerOf(setItem), 100)
    s.setItem('k', v(1))
    await expect(s.flush()).resolves.toBeUndefined()
    expect(setItem).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(setItem).toHaveBeenCalledTimes(2)
    expect(setItem).toHaveBeenLastCalledWith('k', v(1))
  })

  it('a newer value wins over the failed one', async () => {
    let s: ReturnType<typeof deferredPersistStorage<S>>
    const setItem = vi.fn(async (_k: string, val: { state: S }) => {
      if (val.state.n === 1) {
        s.setItem('k', v(2))
        throw new Error('disk')
      }
    })
    s = deferredPersistStorage<S>(innerOf(setItem), 100)
    s.setItem('k', v(1))
    await s.flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(setItem).toHaveBeenLastCalledWith('k', v(2))
    expect(setItem).toHaveBeenCalledTimes(2)
  })

  it('writes soon when idle and after the long delay when busy', async () => {
    let busy = false
    const setItem = vi.fn(async () => {})
    const s = deferredPersistStorage<S>(innerOf(setItem), 1000, {
      idleDelay: 50,
      busy: () => busy,
    })
    s.setItem('k', v(1))
    await vi.advanceTimersByTimeAsync(50)
    expect(setItem).toHaveBeenCalledTimes(1)
    busy = true
    s.setItem('k', v(2))
    await vi.advanceTimersByTimeAsync(500)
    expect(setItem).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(setItem).toHaveBeenCalledTimes(2)
  })

  it('flushDeferredStores writes every store now', async () => {
    const setItem = vi.fn(async () => {})
    const s = deferredPersistStorage<S>(innerOf(setItem), 1000)
    s.setItem('k', v(9))
    await flushDeferredStores()
    expect(setItem).toHaveBeenCalledWith('k', v(9))
  })
})
