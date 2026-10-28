import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const h = vi.hoisted(() => ({
  paneWidth: null as number | null,
  media: {} as Record<string, boolean>,
}))

vi.mock('@/hooks/useCoworkPane', () => ({
  usePaneWidth: () => h.paneWidth,
  usePaneChrome: () => null,
}))
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => h.media[query] ?? false,
}))

import { useCoworkLayout } from '../useCoworkLayout'

const setup = (scroll: HTMLElement | null = null) => {
  const setRail = vi.fn()
  const hook = renderHook(() =>
    useCoworkLayout({ scrollNode: () => scroll, setRail })
  )
  return { hook, setRail }
}

describe('useCoworkLayout breakpoints', () => {
  beforeEach(() => {
    h.paneWidth = null
    h.media = {}
  })

  it('follows the window when the page is not in a pane', () => {
    h.media = {
      '(max-width: 1099px)': true,
      '(max-width: 767px)': false,
      '(max-width: 900px)': true,
      '(max-width: 640px)': false,
    }
    const { hook } = setup()
    expect(hook.result.current.narrow).toBe(true)
    expect(hook.result.current.phone).toBe(false)
    expect(hook.result.current.compactRun).toBe(true)
    expect(hook.result.current.phoneStrip).toBe(false)
  })

  it('follows the pane width when it is in a split pane', () => {
    h.paneWidth = 600
    h.media = { '(max-width: 1099px)': false, '(max-width: 767px)': false }
    const { hook } = setup()
    expect(hook.result.current.narrow).toBe(true)
    expect(hook.result.current.phone).toBe(true)
    expect(hook.result.current.compactRun).toBe(true)
    expect(hook.result.current.phoneStrip).toBe(true)
    expect(hook.result.current.compactViews).toBe(false)
  })

  it('spells views out only in panes of 520px and up', () => {
    h.paneWidth = 500
    expect(setup().hook.result.current.compactViews).toBe(true)
    h.paneWidth = 520
    expect(setup().hook.result.current.compactViews).toBe(false)
  })
})

describe('useCoworkLayout phone views', () => {
  beforeEach(() => {
    h.paneWidth = 400
    h.media = {}
  })

  it('shows the conversation unless a phone chose another view', () => {
    const { hook } = setup()
    expect(hook.result.current.view).toBe('content')
    act(() => hook.result.current.showView('output'))
    expect(hook.result.current.view).toBe('output')
  })

  it('opening the rail on a phone also reveals the output view', () => {
    const { hook, setRail } = setup()
    act(() => hook.result.current.openRail({ kind: 'browser' }))
    expect(setRail).toHaveBeenCalledWith({ kind: 'browser' })
    expect(hook.result.current.view).toBe('output')
    act(() => hook.result.current.closeRail())
    expect(setRail).toHaveBeenLastCalledWith(null)
    expect(hook.result.current.view).toBe('content')
  })

  it('keeps the current view off a phone, where there is only one', () => {
    h.paneWidth = 1400
    const { hook } = setup()
    act(() => hook.result.current.showView('output'))
    expect(hook.result.current.view).toBe('content')
  })
})
