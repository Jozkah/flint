import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PersistStorage } from 'zustand/middleware'
import { deferredPersistStorage } from '../deferredPersistStorage'

const value = (n: number) => ({ state: { n }, version: 0 })

describe('deferredPersistStorage', () => {
  let inner: PersistStorage<{ n: number }>
  beforeEach(() => {
    vi.useFakeTimers()
    inner = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async () => {}),
      removeItem: vi.fn(async () => {}),
    }
  })
  afterEach(() => vi.useRealTimers())

  it('does not write on the call that changed the state', () => {
    const s = deferredPersistStorage(inner, 100)
    s.setItem('k', value(1))
    expect(inner.setItem).not.toHaveBeenCalled()
  })

  it('coalesces a burst into one write of the latest value', async () => {
    const s = deferredPersistStorage(inner, 100)
    s.setItem('k', value(1))
    s.setItem('k', value(2))
    s.setItem('k', value(3))
    await vi.advanceTimersByTimeAsync(100)
    expect(inner.setItem).toHaveBeenCalledTimes(1)
    expect(inner.setItem).toHaveBeenCalledWith('k', value(3))
  })

  it('flush writes pending value at once', async () => {
    const s = deferredPersistStorage(inner, 100)
    s.setItem('k', value(5))
    await s.flush()
    expect(inner.setItem).toHaveBeenCalledWith('k', value(5))
    await vi.advanceTimersByTimeAsync(500)
    expect(inner.setItem).toHaveBeenCalledTimes(1)
  })

  it('removeItem drops a pending write', async () => {
    const s = deferredPersistStorage(inner, 100)
    s.setItem('k', value(1))
    await s.removeItem('k')
    await vi.advanceTimersByTimeAsync(500)
    expect(inner.setItem).not.toHaveBeenCalled()
    expect(inner.removeItem).toHaveBeenCalledWith('k')
  })

  it('overlapping_flushes_write_in_order', async () => {
    const order: number[] = []
    const releases: Array<() => void> = []
    inner.setItem = vi.fn(
      (_k: string, v: { state: { n: number } }) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            order.push(v.state.n)
            resolve()
          })
        })
    ) as unknown as typeof inner.setItem
    const s = deferredPersistStorage(inner, 100)
    s.setItem('k', value(1))
    const f1 = s.flush()
    await vi.advanceTimersByTimeAsync(0) // first write now in flight
    s.setItem('k', value(2))
    const f2 = s.flush()
    await vi.advanceTimersByTimeAsync(0)
    // second write must not start until the first finished
    expect(inner.setItem).toHaveBeenCalledTimes(1)
    releases[0]()
    await f1
    await vi.advanceTimersByTimeAsync(0)
    expect(inner.setItem).toHaveBeenCalledTimes(2)
    releases[1]()
    await f2
    expect(order).toEqual([1, 2])
  })

  it('get_item_returns_pending_value', async () => {
    const s = deferredPersistStorage(inner, 100)
    s.setItem('k', value(7))
    await expect(s.getItem('k')).resolves.toEqual(value(7))
    expect(inner.getItem).not.toHaveBeenCalled()
    await s.getItem('other')
    expect(inner.getItem).toHaveBeenCalledWith('other')
  })

  it('remove_item_waits_for_inflight_write', async () => {
    const events: string[] = []
    let release!: () => void
    inner.setItem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            events.push('set')
            resolve()
          }
        })
    ) as unknown as typeof inner.setItem
    inner.removeItem = vi.fn(async () => {
      events.push('remove')
    })
    const s = deferredPersistStorage(inner, 100)
    s.setItem('k', value(1))
    void s.flush()
    await vi.advanceTimersByTimeAsync(0)
    const removed = s.removeItem('k')
    await vi.advanceTimersByTimeAsync(0)
    expect(inner.removeItem).not.toHaveBeenCalled()
    release()
    await removed
    expect(events).toEqual(['set', 'remove'])
  })
})
