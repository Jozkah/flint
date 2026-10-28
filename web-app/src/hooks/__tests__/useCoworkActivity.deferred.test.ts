import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { setItem } = vi.hoisted(() => ({
  setItem: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem,
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useCoworkActivity } from '../useCoworkActivity'
import { flushDeferredStores } from '@/lib/deferredPersistStorage'
import { taskIdFor, type ActivityTask } from '@/lib/coworkActivity'

const makeTask = (callId: string): ActivityTask =>
  ({
    id: taskIdFor('s-1', 'run-1', callId),
    callId,
    sessionId: 's-1',
    workflowId: 'run-1',
    title: callId,
    status: 'running',
    startedAt: Date.now(),
  }) as unknown as ActivityTask

describe('useCoworkActivity persistence is deferred', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setItem.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a burst of 50 changes results in one write after the delay', async () => {
    for (let i = 0; i < 50; i++) {
      useCoworkActivity.getState().beginTask(makeTask(`c${i}`))
    }
    expect(setItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('flushDeferredStores writes the pending record at once', async () => {
    useCoworkActivity.getState().beginTask(makeTask('flush-me'))
    expect(setItem).not.toHaveBeenCalled()
    await flushDeferredStores()
    expect(setItem).toHaveBeenCalledTimes(1)
  })
})
