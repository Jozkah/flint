import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { AUTOSAVE_MS, useRoomAutosave } from '../useRoomAutosave'

describe('useRoomAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('saves once, 700ms after the last edit', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRoomAutosave('r1'))
    result.current.saveRef.current = save

    act(() => result.current.markEdited())
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_MS - 100)
    })
    expect(save).not.toHaveBeenCalled()
    // Another edit restarts the wait.
    act(() => result.current.markEdited())
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_MS - 100)
    })
    expect(save).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(true)
  })

  it('marks the draft dirty, bumps the generation and clears "saved" on an edit', () => {
    const { result } = renderHook(() => useRoomAutosave('r1'))
    act(() => result.current.setSaved(true))
    expect(result.current.saved).toBe(true)
    const gen = result.current.editGen.current

    act(() => result.current.markEdited())
    expect(result.current.dirty.current).toBe(true)
    expect(result.current.editGen.current).toBe(gen + 1)
    expect(result.current.saved).toBe(false)
  })

  it('flushes a pending edit when the editor goes away', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() => useRoomAutosave('r1'))
    result.current.saveRef.current = save
    act(() => result.current.markEdited())

    unmount()
    expect(save).toHaveBeenCalledWith(true)
  })

  it('does not save on unmount when nothing was edited', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() => useRoomAutosave('r1'))
    result.current.saveRef.current = save
    unmount()
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps the room the draft belongs to, so a save for another room can be refused', () => {
    const { result, rerender } = renderHook(({ id }) => useRoomAutosave(id), {
      initialProps: { id: 'r1' },
    })
    rerender({ id: 'r2' })
    // The ref is set once: the editor moves it on purpose when it adopts room 2.
    expect(result.current.draftRoomId.current).toBe('r1')
  })

  it('runs the latest save, not the one from the first render', () => {
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useRoomAutosave('r1'))
    result.current.saveRef.current = first
    act(() => result.current.markEdited())
    result.current.saveRef.current = second
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_MS)
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
