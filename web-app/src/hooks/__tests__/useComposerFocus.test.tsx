import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { useComposerFocus } from '../useComposerFocus'

function Composer(props: {
  takeFocus: boolean
  threadId?: string
  chatStatus?: string
  onFocused?: (v: boolean) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const handle = useRef({
    focus: () => boxRef.current?.focus(),
    get element() {
      return boxRef.current
    },
  })
  const { isFocused } = useComposerFocus({
    composerRef: handle,
    takeFocus: props.takeFocus,
    threadId: props.threadId,
    chatStatus: props.chatStatus,
  })
  return (
    <>
      <div ref={boxRef} tabIndex={0} data-testid="composer" data-focused={isFocused} />
      <input aria-label="other" />
    </>
  )
}

describe('useComposerFocus', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('takes focus on mount when asked', () => {
    render(<Composer takeFocus />)
    act(() => vi.runAllTimers())
    expect(document.activeElement).toBe(screen.getByTestId('composer'))
    expect(screen.getByTestId('composer').dataset.focused).toBe('true')
  })

  it('does not take focus when takeFocus is false', () => {
    render(<Composer takeFocus={false} />)
    act(() => vi.runAllTimers())
    expect(document.activeElement).toBe(document.body)
  })

  it('does not pull focus out of another field the person is typing in', () => {
    const { rerender } = render(<Composer takeFocus threadId="a" />)
    act(() => vi.runAllTimers())
    screen.getByLabelText('other').focus()
    rerender(<Composer takeFocus threadId="b" />)
    act(() => vi.runAllTimers())
    expect(document.activeElement).toBe(screen.getByLabelText('other'))
  })

  it('refocuses on thread change when focus is idle', () => {
    const { rerender } = render(<Composer takeFocus threadId="a" />)
    act(() => vi.runAllTimers())
    act(() => (document.activeElement as HTMLElement).blur())
    rerender(<Composer takeFocus threadId="b" />)
    act(() => vi.runAllTimers())
    expect(document.activeElement).toBe(screen.getByTestId('composer'))
  })

  it('clears its pending timers on unmount', () => {
    const { unmount } = render(<Composer takeFocus chatStatus="ready" />)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a finished reply refocuses only an idle composer', () => {
    const { rerender } = render(
      <Composer takeFocus threadId="a" chatStatus="streaming" />
    )
    act(() => vi.runAllTimers())
    screen.getByLabelText('other').focus()
    rerender(<Composer takeFocus threadId="a" chatStatus="ready" />)
    act(() => vi.runAllTimers())
    expect(document.activeElement).toBe(screen.getByLabelText('other'))
  })
})
