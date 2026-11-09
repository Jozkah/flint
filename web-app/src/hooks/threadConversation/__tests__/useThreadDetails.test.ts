import { describe, expect, it, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useThreadDetails } from '../useThreadDetails'

// The Details inspector's state as ThreadConversation kept it inline: the
// saved choice opens it, toggling remembers the choice and moves a narrow pane
// to the side that opened, and splitting closes it.
const KEY_VALUES = () => Object.values(localStorage).join(',')

describe('useThreadDetails', () => {
  beforeEach(() => localStorage.clear())

  it('opens from the saved choice and remembers a toggle', () => {
    const { result: first } = renderHook(() => useThreadDetails(false))
    act(() => first.current.toggleDetails())
    const opened = first.current.detailsOpen
    expect(first.current.narrowView).toBe(opened ? 'details' : 'conversation')
    expect(KEY_VALUES()).toContain(String(opened))

    const { result: again } = renderHook(() => useThreadDetails(false))
    expect(again.current.detailsOpen).toBe(opened)
  })

  it('close always leaves the conversation in view and saves closed', () => {
    const { result } = renderHook(() => useThreadDetails(false))
    act(() => result.current.closeDetails())
    expect(result.current.detailsOpen).toBe(false)
    expect(result.current.narrowView).toBe('conversation')
    expect(KEY_VALUES()).toContain('false')
  })

  it('starts closed in a split, and closes when the pane splits', () => {
    localStorage.clear()
    const { result: split } = renderHook(() => useThreadDetails(true))
    expect(split.current.detailsOpen).toBe(false)

    const { result, rerender } = renderHook(({ isSplit }) => useThreadDetails(isSplit), {
      initialProps: { isSplit: false },
    })
    act(() => {
      if (!result.current.detailsOpen) result.current.toggleDetails()
    })
    expect(result.current.detailsOpen).toBe(true)
    rerender({ isSplit: true })
    expect(result.current.detailsOpen).toBe(false)
    expect(result.current.narrowView).toBe('conversation')
  })

  it('gives the panel a stable id', () => {
    const { result, rerender } = renderHook(() => useThreadDetails(false))
    const id = result.current.detailsPanelId
    rerender()
    expect(result.current.detailsPanelId).toBe(id)
  })
})
