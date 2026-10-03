import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { RowPreview } from '../RowPreview'

vi.mock('@/hooks/usePreviewSummary', () => ({
  usePreviewSummary: () => ({ summary: undefined, loading: false }),
}))

const row = (suppressed: boolean) => (
  <RowPreview title="Chat title" summary="first" suppressed={suppressed}>
    <button>row</button>
  </RowPreview>
)

describe('RowPreview', () => {
  it('does not come back when the menu closes after a hover', () => {
    vi.useFakeTimers()
    const { rerender } = render(row(false))
    fireEvent.pointerEnter(screen.getByText('row'))
    fireEvent.mouseEnter(screen.getByText('row'))
    act(() => void vi.advanceTimersByTime(800))
    expect(screen.queryByText('Chat title')).toBeTruthy()
    rerender(row(true)) // menu opens
    expect(screen.queryByText('Chat title')).toBeNull()
    rerender(row(false)) // an item was picked, menu closes
    act(() => void vi.advanceTimersByTime(800))
    expect(screen.queryByText('Chat title')).toBeNull()
    vi.useRealTimers()
  })

  it('does not open from focus alone, with the pointer elsewhere', () => {
    vi.useFakeTimers()
    render(row(false))
    fireEvent.focus(screen.getByText('row'))
    act(() => void vi.advanceTimersByTime(800))
    expect(screen.queryByText('Chat title')).toBeNull()
    vi.useRealTimers()
  })

  it('does not open after the row was pressed, until the pointer returns', () => {
    vi.useFakeTimers()
    render(row(false))
    const button = screen.getByText('row')
    fireEvent.pointerEnter(button)
    fireEvent.pointerDown(button)
    act(() => void vi.advanceTimersByTime(800))
    expect(screen.queryByText('Chat title')).toBeNull()
    fireEvent.pointerLeave(button)
    fireEvent.pointerEnter(button)
    act(() => void vi.advanceTimersByTime(800))
    expect(screen.queryByText('Chat title')).toBeTruthy()
    vi.useRealTimers()
  })
})
