import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PREVIEW_SIDE_OFFSET, RowPreview, previewSideOffset } from '../RowPreview'

vi.mock('@/hooks/usePreviewSummary', () => ({
  usePreviewSummary: () => ({ summary: undefined, loading: false }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o?.count !== undefined ? `${k}#${o.count}` : k,
  }),
}))

const row = (suppressed: boolean) => (
  <RowPreview title="Chat title" summary="first" suppressed={suppressed}>
    <button>row</button>
  </RowPreview>
)

describe('previewSideOffset', () => {
  it('starts the card 8px past the sidebar edge, not the row edge', () => {
    const aside = document.createElement('aside')
    const row = document.createElement('button')
    aside.appendChild(row)
    document.body.appendChild(aside)
    vi.spyOn(aside, 'getBoundingClientRect').mockReturnValue({ right: 250 } as DOMRect)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ right: 228 } as DOMRect)
    expect(previewSideOffset(row)).toBe(250 - 228 + 8)
    aside.remove()
  })

  it('keeps the plain gap outside a sidebar', () => {
    const row = document.createElement('button')
    document.body.appendChild(row)
    expect(previewSideOffset(row)).toBe(PREVIEW_SIDE_OFFSET)
    row.remove()
  })
})

describe('RowPreview model', () => {
  const open = (model: { provider: string; id: string } | null) => {
    vi.useFakeTimers()
    render(
      <RowPreview title="Chat title" model={model} suppressed={false}>
        <button>row</button>
      </RowPreview>
    )
    fireEvent.pointerEnter(screen.getByText('row'))
    fireEvent.mouseEnter(screen.getByText('row'))
    act(() => void vi.advanceTimersByTime(800))
  }
  it("shows no model for a thread that never picked one ('*')", () => {
    open({ provider: 'llama.cpp', id: '*' })
    expect(screen.queryByText('Chat title')).toBeTruthy()
    expect(screen.queryByText('*')).toBeNull()
    vi.useRealTimers()
  })
  it('still names a real model id', () => {
    open({ provider: 'llama.cpp', id: 'qwen-7b' })
    expect(screen.queryByText('qwen-7b')).toBeTruthy()
    vi.useRealTimers()
  })
})

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

  it('shows one card at a time: opening a second row shuts the first at once', () => {
    vi.useFakeTimers()
    render(
      <>
        <RowPreview title="First card" suppressed={false}>
          <button>a</button>
        </RowPreview>
        <RowPreview title="Second card" suppressed={false}>
          <button>b</button>
        </RowPreview>
      </>
    )
    fireEvent.pointerEnter(screen.getByText('a'))
    fireEvent.mouseEnter(screen.getByText('a'))
    act(() => void vi.advanceTimersByTime(600))
    expect(screen.queryByText('First card')).toBeTruthy()
    fireEvent.pointerEnter(screen.getByText('b'))
    fireEvent.mouseEnter(screen.getByText('b'))
    act(() => void vi.advanceTimersByTime(600))
    expect(screen.queryByText('Second card')).toBeTruthy()
    expect(screen.queryByText('First card')).toBeNull()
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

  it('shows title, clamped summary, and the empty state for an empty summary', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <RowPreview title="T" summary={'long '.repeat(200)} meta={{ updated: Date.now() }} suppressed={false}>
        <button>row</button>
      </RowPreview>
    )
    fireEvent.pointerEnter(screen.getByText('row'))
    fireEvent.mouseEnter(screen.getByText('row'))
    act(() => void vi.advanceTimersByTime(600))
    expect(screen.getByTestId('row-preview-summary').className).toContain('line-clamp-4')
    expect(screen.getByTestId('row-preview-time')).toBeTruthy()
    rerender(
      <RowPreview title="T" summary="" suppressed={false}>
        <button>row</button>
      </RowPreview>
    )
    expect(screen.queryByTestId('row-preview-summary')).toBeNull()
    expect(screen.getByTestId('row-preview-empty')).toBeTruthy()
    expect(screen.getByTestId('row-preview-title').textContent).toBe('T')
    vi.useRealTimers()
  })

  it('reads the first question and the count from disk when it opens, and no sooner', async () => {
    vi.useFakeTimers()
    const facts = vi.fn(async () => ({ first: 'hello there', count: 2 }))
    render(
      <RowPreview title="T" facts={facts} suppressed={false}>
        <button>row</button>
      </RowPreview>
    )
    expect(facts).not.toHaveBeenCalled()
    fireEvent.pointerEnter(screen.getByText('row'))
    fireEvent.mouseEnter(screen.getByText('row'))
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
    })
    expect(facts).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('row-preview-summary').textContent).toBe('hello there')
    expect(screen.getByTestId('row-preview-count').textContent).toBe('common:previewMessageCount#2')
    vi.useRealTimers()
  })

  it('survives a facts loader that rejects without an unhandled rejection', async () => {
    vi.useFakeTimers()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const facts = vi.fn(async () => {
      throw new Error('disk')
    })
    render(
      <RowPreview title="T" facts={facts} suppressed={false}>
        <button>row</button>
      </RowPreview>
    )
    fireEvent.pointerEnter(screen.getByText('row'))
    fireEvent.mouseEnter(screen.getByText('row'))
    await act(async () => {
      vi.advanceTimersByTime(600)
      await Promise.resolve()
      await Promise.resolve()
    })
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 10))
    process.off('unhandledRejection', unhandled)
    expect(facts).toHaveBeenCalled()
    expect(unhandled).not.toHaveBeenCalled()
    expect(screen.getByTestId('row-preview-title')).toBeTruthy()
    err.mockRestore()
  })

  it('shows the keyboard hint when opened from focus, not from the pointer', () => {
    vi.useFakeTimers()
    render(row(false))
    const button = screen.getByText('row')
    const matches = vi.spyOn(button, 'matches').mockReturnValue(true)
    fireEvent.focus(button)
    act(() => void vi.advanceTimersByTime(600))
    expect(screen.getByTestId('row-preview-hint')).toBeTruthy()
    matches.mockRestore()
    vi.useRealTimers()
  })

  it('opens from keyboard focus (focus-visible) but not from other focus', () => {
    vi.useFakeTimers()
    render(row(false))
    const button = screen.getByText('row')
    const matches = vi.spyOn(button, 'matches').mockReturnValue(true)
    fireEvent.focus(button)
    act(() => void vi.advanceTimersByTime(600))
    expect(screen.queryByText('Chat title')).toBeTruthy()
    matches.mockRestore()
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
