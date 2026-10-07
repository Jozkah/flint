import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SwipeRow } from '../ui/swipe-row'
import { dragX as drag, pointer } from './pointer'

function setup(
  over: { confirm?: () => boolean; onCommit?: () => unknown } = {}
) {
  const onSelect = vi.fn()
  const onCommit = vi.fn(over.onCommit ?? (() => undefined))
  render(
    <SwipeRow
      toggleLabel="Actions for Chat"
      secondary={{ label: 'Restore', icon: <i />, onSelect }}
      primary={{
        label: 'Delete',
        icon: <i />,
        confirm: over.confirm,
        onCommit,
      }}
    >
      <button type="button">Chat</button>
    </SwipeRow>
  )
  const surf = screen.getByText('Chat').parentElement as HTMLElement
  return {
    surf,
    onSelect,
    onCommit,
    wrap: surf.closest('.sr-wrap') as HTMLElement,
  }
}

const tx = (el: HTMLElement) =>
  Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? NaN)

describe('SwipeRow', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens on a swipe past half the actions and closes on a tap', () => {
    const { surf, wrap } = setup()
    drag(surf, [300, 280, 240, 200], 0, true, 100)
    expect(wrap).toHaveAttribute('data-open')
    expect(tx(surf)).toBe(-152)
    pointer(surf, 'pointerdown', { x: 100, t: 5000 })
    pointer(surf, 'pointerup', { x: 100, t: 5010 })
    fireEvent.click(screen.getByText('Chat'))
    expect(wrap).not.toHaveAttribute('data-open')
    expect(Math.abs(tx(surf))).toBe(0)
  })

  it('snaps shut when released short of half', () => {
    const { surf, wrap } = setup()
    drag(surf, [300, 270, 269], 0, true, 200)
    expect(wrap).not.toHaveAttribute('data-open')
    expect(Math.abs(tx(surf))).toBe(0)
  })

  it('resists past the actions', () => {
    const { surf } = setup()
    drag(surf, [300, 100], 0, false)
    // 200px of travel, but the row only follows part of the way past 152.
    expect(-tx(surf)).toBeGreaterThan(152)
    expect(-tx(surf)).toBeLessThan(190)
  })

  it('ignores mostly vertical drags', () => {
    const { surf } = setup()
    pointer(surf, 'pointerdown', { x: 300, y: 0, id: 2 })
    pointer(surf, 'pointermove', { x: 280, y: 90, id: 2, t: 99 })
    expect(Math.abs(tx(surf))).toBe(0)
  })

  it('a long swipe commits: expands, slides out, collapses, then calls back', async () => {
    const { surf, wrap, onCommit } = setup()
    drag(surf, [320, 280, 200, 100, 20])
    expect(wrap).toHaveAttribute('data-phase', 'committing')
    expect(onCommit).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(220)
    })
    expect(wrap).toHaveAttribute('data-phase', 'collapsing')
    expect(wrap.style.height).toBe('0px')
    expect(onCommit).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(wrap).toHaveAttribute('data-collapsed')
  })

  it('brings the row back when the commit is refused', async () => {
    const { surf, wrap, onCommit } = setup({ onCommit: () => false })
    drag(surf, [320, 280, 200, 100, 20])
    await act(async () => {
      vi.advanceTimersByTime(420)
    })
    expect(onCommit).toHaveBeenCalled()
    expect(wrap).toHaveAttribute('data-phase', 'idle')
    expect(wrap).not.toHaveAttribute('data-collapsed')
  })

  it('a declined confirmation springs back without committing', () => {
    const { surf, wrap, onCommit } = setup({ confirm: () => false })
    drag(surf, [320, 280, 200, 100, 20])
    expect(wrap).toHaveAttribute('data-phase', 'idle')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('the hidden button toggles the actions and the action buttons work', () => {
    const { wrap, onSelect } = setup()
    const toggle = screen.getByRole('button', { name: 'Actions for Chat' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(wrap).toHaveAttribute('data-open')
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(onSelect).toHaveBeenCalled()
    expect(wrap).not.toHaveAttribute('data-open')
  })

  it('the Delete button commits the same way', async () => {
    const { wrap, onCommit } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => {
      vi.advanceTimersByTime(420)
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(wrap).toHaveAttribute('data-collapsed')
  })
})
