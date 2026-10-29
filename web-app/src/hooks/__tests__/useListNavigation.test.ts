import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useListNavigation } from '../useListNavigation'

const key = (k: string) => ({ key: k, preventDefault: vi.fn() })

describe('useListNavigation', () => {
  it('clamps at both ends without wrap', () => {
    const { result } = renderHook(() => useListNavigation({ count: 3 }))
    act(() => {
      result.current.onNavKey(key('ArrowUp'))
    })
    expect(result.current.active).toBe(0)
    for (let i = 0; i < 5; i++) {
      act(() => {
        result.current.onNavKey(key('ArrowDown'))
      })
    }
    expect(result.current.active).toBe(2)
  })

  it('wraps around when asked', () => {
    const { result } = renderHook(() => useListNavigation({ count: 3, wrap: true }))
    act(() => {
      result.current.onNavKey(key('ArrowUp'))
    })
    expect(result.current.active).toBe(2)
    act(() => {
      result.current.onNavKey(key('ArrowDown'))
    })
    expect(result.current.active).toBe(0)
  })

  it('consumes only navigation keys', () => {
    const { result } = renderHook(() => useListNavigation({ count: 3 }))
    const down = key('ArrowDown')
    const enter = key('Enter')
    const home = key('Home')
    let handled = false
    act(() => {
      handled = result.current.onNavKey(down)
    })
    expect(handled).toBe(true)
    expect(down.preventDefault).toHaveBeenCalled()
    expect(result.current.onNavKey(enter)).toBe(false)
    expect(enter.preventDefault).not.toHaveBeenCalled()
    // Home/End belong to the text field unless enabled.
    expect(result.current.onNavKey(home)).toBe(false)
  })

  it('Home and End jump when enabled', () => {
    const { result } = renderHook(() => useListNavigation({ count: 4, homeEnd: true }))
    act(() => {
      result.current.onNavKey(key('End'))
    })
    expect(result.current.active).toBe(3)
    act(() => {
      result.current.onNavKey(key('Home'))
    })
    expect(result.current.active).toBe(0)
  })

  it('resets to the top when the reset key changes', () => {
    const { result, rerender } = renderHook(
      ({ q }) => useListNavigation({ count: 5, resetKey: q }),
      { initialProps: { q: 'a' } }
    )
    act(() => result.current.setActive(3))
    rerender({ q: 'a' })
    expect(result.current.active).toBe(3)
    rerender({ q: 'ab' })
    expect(result.current.active).toBe(0)
  })

  it('scrolls the row it lands on into view', () => {
    const scrollTo = vi.fn()
    const { result } = renderHook(() => useListNavigation({ count: 3, scrollTo }))
    act(() => {
      result.current.onNavKey(key('ArrowDown'))
    })
    expect(scrollTo).toHaveBeenLastCalledWith(1)
  })

  it('an empty list stays at 0', () => {
    const { result } = renderHook(() => useListNavigation({ count: 0, wrap: true }))
    act(() => {
      result.current.onNavKey(key('ArrowDown'))
    })
    expect(result.current.active).toBe(0)
  })
})
