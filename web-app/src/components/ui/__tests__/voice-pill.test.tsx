import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { VoicePill, type VoicePillProps } from '../voice-pill'

// jsdom has no PointerEvent: a MouseEvent that carries the pointer fields.
class TestPointerEvent extends MouseEvent {
  pointerId: number
  isPrimary: boolean
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
    this.isPrimary = init.isPrimary ?? false
  }
}
vi.stubGlobal('PointerEvent', TestPointerEvent)

function setup(props: Partial<VoicePillProps> = {}) {
  const onBegin = vi.fn()
  const onEnd = vi.fn()
  const utils = render(
    <VoicePill
      listening={false}
      cancelLabel="Cancel"
      aria-label="Dictate"
      onBegin={onBegin}
      onEnd={onEnd}
      {...props}
    />
  )
  const button = screen.getByRole('button')
  const rerender = (next: Partial<VoicePillProps>) =>
    utils.rerender(
      <VoicePill
        listening={false}
        cancelLabel="Cancel"
        aria-label="Dictate"
        onBegin={onBegin}
        onEnd={onEnd}
        {...props}
        {...next}
      />
    )
  return { button, onBegin, onEnd, rerender }
}

const ptr = (x = 100) => ({
  pointerId: 1,
  isPrimary: true,
  button: 0,
  clientX: x,
})

describe('VoicePill', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('begins on press and keeps recording after a short tap', () => {
    const { button, onBegin, onEnd } = setup()
    fireEvent.pointerDown(button, ptr())
    expect(onBegin).toHaveBeenCalledTimes(1)
    act(() => void vi.advanceTimersByTime(100))
    fireEvent.pointerUp(button, ptr())
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('a second tap while listening ends with tap', () => {
    const { button, onBegin, onEnd } = setup({ listening: true })
    fireEvent.pointerDown(button, ptr())
    fireEvent.pointerUp(button, ptr())
    expect(onBegin).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledWith('tap')
  })

  it('press and hold past 300ms ends on release', () => {
    const { button, onEnd, rerender } = setup()
    fireEvent.pointerDown(button, ptr())
    rerender({ listening: true })
    act(() => void vi.advanceTimersByTime(450))
    fireEvent.pointerUp(button, ptr())
    expect(onEnd).toHaveBeenCalledWith('release')
  })

  it('release before listening starts stops once it does', () => {
    const { button, onEnd, rerender } = setup()
    fireEvent.pointerDown(button, ptr())
    rerender({ busy: true })
    act(() => void vi.advanceTimersByTime(450))
    fireEvent.pointerUp(button, ptr())
    expect(onEnd).not.toHaveBeenCalled()
    rerender({ listening: true, busy: false })
    expect(onEnd).toHaveBeenCalledWith('release')
  })

  it('dragging left past 64px while holding cancels once', () => {
    const { button, onEnd, rerender } = setup()
    fireEvent.pointerDown(button, ptr(200))
    rerender({ listening: true })
    fireEvent.pointerMove(button, ptr(170))
    expect(onEnd).not.toHaveBeenCalled()
    expect(button.style.getPropertyValue('--vp-cancel')).not.toBe('0')
    fireEvent.pointerMove(button, ptr(120))
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledWith('cancel')
    act(() => void vi.advanceTimersByTime(450))
    fireEvent.pointerUp(button, ptr(120))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('Space and Enter toggle', () => {
    const { button, onBegin, onEnd, rerender } = setup()
    fireEvent.keyDown(button, { key: ' ' })
    expect(onBegin).toHaveBeenCalledTimes(1)
    rerender({ listening: true })
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(onEnd).toHaveBeenCalledWith('key')
  })

  it('ignores presses while busy and shows the spinner state', () => {
    const { button, onBegin, onEnd } = setup({ busy: true })
    fireEvent.pointerDown(button, ptr())
    fireEvent.keyDown(button, { key: ' ' })
    expect(onBegin).not.toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
    expect(button).toHaveAttribute('data-busy')
  })

  it('opens (data-state) only while listening and runs the clock', () => {
    const { button, rerender } = setup()
    expect(button).toHaveAttribute('data-state', 'idle')
    rerender({ listening: true })
    expect(button).toHaveAttribute('data-state', 'listening')
    act(() => void vi.advanceTimersByTime(3200))
    expect(button.querySelector('.vp-time')?.textContent).toMatch(/^0:0[1-3]$/)
  })
})
