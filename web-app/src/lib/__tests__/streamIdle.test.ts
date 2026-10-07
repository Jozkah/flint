import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdleWatchdog, streamIdleMessage } from '../streamIdle'

describe('stream idle watchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once after a silence', () => {
    const idle = vi.fn()
    createIdleWatchdog(1000, idle)
    vi.advanceTimersByTime(999)
    expect(idle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(idle).toHaveBeenCalledTimes(1)
  })

  it('is held off by every part that arrives', () => {
    const idle = vi.fn()
    const dog = createIdleWatchdog(1000, idle)
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900)
      dog.touch()
    }
    expect(idle).not.toHaveBeenCalled()
  })

  it('does not fire once stopped', () => {
    const idle = vi.fn()
    createIdleWatchdog(1000, idle).stop()
    vi.advanceTimersByTime(5000)
    expect(idle).not.toHaveBeenCalled()
  })

  it('says how long and what to do', () => {
    expect(streamIdleMessage(10 * 60_000)).toMatch(/10 minutes.*again/s)
  })
})
