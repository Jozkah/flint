import { beforeEach, describe, expect, it } from 'vitest'
import { useToolCallRuntime } from '../useToolCallRuntime'
import { loggedToolTiming, resetToolTimingLog } from '@/lib/toolTimingLog'

describe('leaving a conversation mid tool call', () => {
  beforeEach(() => {
    resetToolTimingLog()
    useToolCallRuntime.getState().reset()
  })

  it('keeps the running call duration after reset', () => {
    const s = useToolCallRuntime.getState()
    s.enqueue(['a'], 't1')
    s.markRunning('a')
    s.reset()
    s.markSettled('a') // too late: entry is gone
    expect(loggedToolTiming('a')).toBeDefined()
  })

  it('keeps the running call duration after forget', () => {
    const s = useToolCallRuntime.getState()
    s.enqueue(['b'], 't1')
    s.markRunning('b')
    s.forget(['b'])
    expect(loggedToolTiming('b')).toBeDefined()
  })
})
