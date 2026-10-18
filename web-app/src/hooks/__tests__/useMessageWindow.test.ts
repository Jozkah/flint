import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  MESSAGE_WINDOW_INITIAL,
  MESSAGE_WINDOW_STEP,
  useMessageWindow,
} from '../useMessageWindow'

describe('useMessageWindow', () => {
  it('mounts only the tail of a long chat, also when messages load late', () => {
    const { result, rerender } = renderHook(
      ({ n, k }) => useMessageWindow(n, k),
      { initialProps: { n: 0, k: 'a' } }
    )
    expect(result.current.start).toBe(0)
    rerender({ n: 300, k: 'a' })
    expect(result.current.start).toBe(300 - MESSAGE_WINDOW_INITIAL)
    expect(result.current.hasEarlier).toBe(true)
  })

  it('short chats render everything', () => {
    const { result } = renderHook(() => useMessageWindow(3, 'a'))
    expect(result.current.start).toBe(0)
    expect(result.current.hasEarlier).toBe(false)
  })

  it('new messages widen the window instead of unmounting older ones', () => {
    const { result, rerender } = renderHook(
      ({ n }) => useMessageWindow(n, 'a'),
      { initialProps: { n: 100 } }
    )
    const start = result.current.start
    rerender({ n: 102 })
    expect(result.current.start).toBe(start)
  })

  it('grows on loadEarlier and on reveal, resets on another chat', () => {
    const { result, rerender } = renderHook(
      ({ k }) => useMessageWindow(300, k),
      { initialProps: { k: 'a' } }
    )
    act(() => result.current.loadEarlier())
    expect(result.current.start).toBe(
      300 - MESSAGE_WINDOW_INITIAL - MESSAGE_WINDOW_STEP
    )
    act(() => result.current.reveal(5))
    expect(result.current.start).toBeLessThanOrEqual(5)
    rerender({ k: 'b' })
    expect(result.current.start).toBe(300 - MESSAGE_WINDOW_INITIAL)
  })
})
