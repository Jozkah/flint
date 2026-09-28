import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTaskbarAttentionForTests, syncTaskbarAttention } from '@/lib/taskbarAttention'

const requestUserAttention = vi.fn(async () => {})
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  requestUserAttention.mockClear()
  resetTaskbarAttentionForTests(async () => ({ requestUserAttention }))
})

describe('taskbar attention for waiting approvals', () => {
  it('flashes for a new approval while Flint is in the background, once', async () => {
    syncTaskbarAttention(['a'], false)
    syncTaskbarAttention(['a'], false)
    await flush()
    expect(requestUserAttention).toHaveBeenCalledTimes(1)
    expect(requestUserAttention).toHaveBeenCalledWith(1)

    // A second approval flashes again.
    syncTaskbarAttention(['a', 'b'], false)
    await flush()
    expect(requestUserAttention).toHaveBeenCalledTimes(2)
  })

  it('does not flash while Flint is in front', async () => {
    syncTaskbarAttention(['a'], true)
    await flush()
    expect(requestUserAttention).not.toHaveBeenCalled()
  })

  it('stops once nothing is waiting', async () => {
    syncTaskbarAttention(['a'], false)
    syncTaskbarAttention([], false)
    await flush()
    expect(requestUserAttention).toHaveBeenLastCalledWith(null)
    // Nothing was flashing: nothing to clear.
    requestUserAttention.mockClear()
    syncTaskbarAttention([], false)
    await flush()
    expect(requestUserAttention).not.toHaveBeenCalled()
  })

  it('never throws where the platform has no attention request', async () => {
    resetTaskbarAttentionForTests(async () => ({
      requestUserAttention: async () => {
        throw new Error('unsupported')
      },
    }))
    expect(() => syncTaskbarAttention(['a'], false)).not.toThrow()
    await flush()
  })
})
