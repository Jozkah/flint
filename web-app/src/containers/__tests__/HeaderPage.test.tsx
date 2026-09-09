import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import HeaderPage from '../HeaderPage'

/**
 * The window has no native decorations, so it is dragged by the header.
 *
 * Tauri drags only when the element actually pressed carries
 * `data-tauri-drag-region`; the attribute does not pass down to children. The
 * header's inner row is `w-full`, so it covered the bar end to end and
 * swallowed every press the outer element was meant to receive. The only
 * draggable strip left was the outer padding -- the window moved only when the
 * pointer was within a few pixels of the edge.
 *
 * These assert the property rather than the markup: every element that spans
 * the bar and holds no control of its own has to be draggable, or the bar has
 * dead space again.
 */

vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: () => ({ open: false, setLeftPanel: vi.fn() }),
}))

vi.mock('@/stores/titlebar-layout-store', () => ({
  useTitlebarLayout: (select: (s: unknown) => unknown) =>
    select({ layout: { left: [], right: [] } }),
}))

describe('HeaderPage drag region', () => {
  it('makes the full-width row draggable, not just the padding', () => {
    const { container } = render(<HeaderPage />)

    const outer = container.firstElementChild as HTMLElement
    expect(outer).toBeTruthy()
    expect(outer.hasAttribute('data-tauri-drag-region')).toBe(true)

    // The row that spans the header. Before the fix this had no attribute and
    // covered the whole bar.
    const row = outer.querySelector(':scope > div') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.className).toContain('w-full')
    expect(row.hasAttribute('data-tauri-drag-region')).toBe(true)
  })

  it('makes the stretch that fills the bar draggable', () => {
    const { container } = render(<HeaderPage />)
    const stretch = container.querySelector('.flex-1') as HTMLElement
    expect(stretch).toBeTruthy()
    expect(stretch.hasAttribute('data-tauri-drag-region')).toBe(true)
  })

  /**
   * The other half of the bargain: controls must stay clickable. An element
   * that is itself a drag region cannot be pressed for its own sake, so the
   * sidebar toggle must NOT carry the attribute.
   */
  it('leaves controls clickable rather than draggable', () => {
    render(<HeaderPage />)
    const toggle = screen.getByLabelText('Toggle sidebar')
    expect(toggle.hasAttribute('data-tauri-drag-region')).toBe(false)
    expect(toggle.closest('[data-tauri-drag-region]')).not.toBe(toggle)
  })
})
