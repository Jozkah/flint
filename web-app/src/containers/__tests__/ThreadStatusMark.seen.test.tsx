import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useThreadStatus } from '@/containers/ThreadStatusMark'
import { useSeen } from '@/stores/seen-store'

describe('useThreadStatus seen tracking', () => {
  beforeEach(() => useSeen.setState({ seen: {} }))

  it('shows the recent dot for an unseen chat that just finished', () => {
    const { result } = renderHook(() =>
      useThreadStatus({ updated: Date.now() - 60_000 }, false, false, {
        id: 't1',
      })
    )
    expect(result.current).toBe('recent')
  })

  it('clears the dot while the chat is open and after it was seen', () => {
    const updated = Date.now() - 60_000
    const open = renderHook(() =>
      useThreadStatus({ updated }, false, false, { id: 't1', selected: true })
    )
    expect(open.result.current).toBe('none')
    expect(useSeen.getState().seen.t1).toBeGreaterThanOrEqual(updated)

    const later = renderHook(() =>
      useThreadStatus({ updated }, false, false, { id: 't1' })
    )
    expect(later.result.current).toBe('none')
  })

  it('still shows the working dot on the open chat', () => {
    const { result } = renderHook(() =>
      useThreadStatus({ updated: Date.now() }, true, false, {
        id: 't2',
        selected: true,
      })
    )
    expect(result.current).toBe('active')
  })
})
