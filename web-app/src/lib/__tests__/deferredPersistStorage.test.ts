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
})
