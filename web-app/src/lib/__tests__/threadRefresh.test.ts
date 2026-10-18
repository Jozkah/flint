import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { threadChanged, useRefreshWhenVisible } from '../threadRefresh'

describe('threadChanged', () => {
  const m = (id: string, text: string) => ({ id, content: [{ type: 'text', text: { value: text } }] })

  it('sees a message another tab added, or a reply that grew', () => {
    expect(threadChanged([m('a', 'hi')], [m('a', 'hi'), m('b', 'reply')])).toBe(true)
    expect(threadChanged([m('a', 'hi'), m('b', 'par')], [m('a', 'hi'), m('b', 'partial reply')])).toBe(true)
  })

  it('leaves an identical or empty server copy alone', () => {
    expect(threadChanged([m('a', 'hi')], [m('a', 'hi')])).toBe(false)
    expect(threadChanged([m('a', 'hi')], [])).toBe(false)
  })
})

describe('useRefreshWhenVisible', () => {
  it('reads again when the tab comes back or the window is focused', () => {
    const refresh = vi.fn()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(10_000)
    const { unmount } = renderHook(() => useRefreshWhenVisible(true, refresh))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(refresh).toHaveBeenCalledTimes(1)
    // Focus right after the visibility change: one read, not two.
    window.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(1)
    now.mockReturnValue(20_000)
    window.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(2)
    unmount()
    now.mockReturnValue(30_000)
    window.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })

  it('does nothing when disabled (the desktop app)', () => {
    const refresh = vi.fn()
    renderHook(() => useRefreshWhenVisible(false, refresh))
    window.dispatchEvent(new Event('focus'))
    expect(refresh).not.toHaveBeenCalled()
  })
})
