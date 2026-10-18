import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { shouldWarnBeforeLeaving, useLeaveGuard } from '../useLeaveGuard'
import { useCoworkRun } from '../useCoworkRun'

const unload = () => {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('leaving the page while a run is live', () => {
  beforeEach(() => {
    useCoworkRun.setState({ runs: {} })
  })

  it('warns only when a run is live', () => {
    expect(shouldWarnBeforeLeaving(0)).toBe(false)
    expect(shouldWarnBeforeLeaving(1)).toBe(true)
  })

  it('asks the browser to confirm while a run is live, and not otherwise', () => {
    const { unmount } = renderHook(() => useLeaveGuard())
    expect(unload().defaultPrevented).toBe(false)

    act(() => {
      useCoworkRun.setState({ runs: { s1: { runId: 'r1', startedAt: Date.now() } } })
    })
    expect(unload().defaultPrevented).toBe(true)

    act(() => {
      useCoworkRun.setState({ runs: {} })
    })
    expect(unload().defaultPrevented).toBe(false)
    unmount()
  })

  it('stops asking once the page that mounted the guard is gone', () => {
    useCoworkRun.setState({ runs: { s1: { runId: 'r1', startedAt: Date.now() } } })
    const { unmount } = renderHook(() => useLeaveGuard())
    expect(unload().defaultPrevented).toBe(true)
    unmount()
    expect(unload().defaultPrevented).toBe(false)
  })
})
