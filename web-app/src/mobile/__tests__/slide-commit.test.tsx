import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SlideCommit } from '../ui/slide-commit'
import { dragX, pointer } from './pointer'

function setup(onCommit: () => Promise<unknown>) {
  render(<SlideCommit label="Allow once" onCommit={onCommit} testId="allow" />)
  const slider = screen.getByRole('slider', { name: 'Allow once' })
  const track = slider.parentElement as HTMLElement
  return { slider, track, root: track.parentElement as HTMLElement }
}

describe('SlideCommit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('exposes a slider with the given test id', () => {
    const { slider } = setup(async () => true)
    expect(slider).toHaveAttribute('data-testid', 'allow')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
  })

  it('springs back when released early', () => {
    const onCommit = vi.fn(async () => true)
    const { slider, track } = setup(onCommit)
    dragX(track, [10, 60, 90])
    expect(onCommit).not.toHaveBeenCalled()
    expect(slider).toHaveAttribute('aria-valuenow', '0')
  })

  it('sliding all the way shows pending, then done', async () => {
    let finish: (v: boolean) => void = () => {}
    const onCommit = vi.fn(() => new Promise<boolean>((r) => (finish = r)))
    const { slider, track, root } = setup(onCommit)
    dragX(track, [0, 100, 260])
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(root).toHaveAttribute('data-phase', 'pending')
    expect(slider).toHaveAttribute('aria-valuenow', '100')
    await act(async () => {
      finish(true)
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(root).toHaveAttribute('data-phase', 'done')
  })

  it('a failed call shakes with the error label, then resets', async () => {
    const { slider, root } = setup(async () => {
      throw new Error('no')
    })
    fireEvent.keyDown(slider, { key: 'End' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(root).toHaveAttribute('data-phase', 'error')
    expect(screen.getByText('Didn’t work, try again')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(root).toHaveAttribute('data-phase', 'idle')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
  })

  it('a call that resolves false counts as failed', async () => {
    const { slider, root } = setup(async () => false)
    fireEvent.keyDown(slider, { key: 'End' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(root).toHaveAttribute('data-phase', 'error')
  })

  it('keyboard: arrows step, Home and Escape reset, End approves', async () => {
    const onCommit = vi.fn(async () => true)
    const { slider, root } = setup(onCommit)
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider).toHaveAttribute('aria-valuenow', '25')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(slider).toHaveAttribute('aria-valuenow', '25')
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'Escape' })
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(slider, { key: 'End' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(root).toHaveAttribute('data-phase', 'done')
    // Once done it cannot be sent again.
    fireEvent.keyDown(slider, { key: 'End' })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('a disabled control does nothing', () => {
    const onCommit = vi.fn(async () => true)
    render(<SlideCommit label="Allow once" onCommit={onCommit} disabled />)
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'End' })
    pointer(slider.parentElement as HTMLElement, 'pointerdown', { x: 0 })
    expect(onCommit).not.toHaveBeenCalled()
  })
})
