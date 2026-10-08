import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

const dismiss = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { dismiss, custom: vi.fn() } }))

import { UndoToast } from '../UndoToast'

function setup(onUndo = vi.fn()) {
  render(
    <UndoToast
      toastId="t1"
      message="Thread archived"
      description="Back soon"
      undoLabel="Undo"
      onUndo={onUndo}
      durationMs={4000}
    />
  )
  return onUndo
}

describe('UndoToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dismiss.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('shows the message as a status with a real Undo button', () => {
    setup()
    expect(screen.getByRole('status')).toHaveTextContent('Thread archived')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('dismisses itself when the time runs out', () => {
    setup()
    act(() => void vi.advanceTimersByTime(3900))
    expect(dismiss).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(200))
    expect(dismiss).toHaveBeenCalledWith('t1')
  })

  it('pauses on hover and resumes with the time left', () => {
    setup()
    const card = screen.getByTestId('undo-toast')
    act(() => void vi.advanceTimersByTime(3000))
    fireEvent.pointerEnter(card)
    expect(card).toHaveAttribute('data-paused', 'true')
    act(() => void vi.advanceTimersByTime(10000))
    expect(dismiss).not.toHaveBeenCalled()
    fireEvent.pointerLeave(card)
    act(() => void vi.advanceTimersByTime(900))
    expect(dismiss).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(200))
    expect(dismiss).toHaveBeenCalledWith('t1')
  })

  it('undo cancels the timer, dismisses and calls back', () => {
    const onUndo = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledTimes(1)
    act(() => void vi.advanceTimersByTime(5000))
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
