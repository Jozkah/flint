import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import HeaderPage from '../HeaderPage'
import PageHeaderRow from '../PageHeaderRow'

/**
 * The window has no native decorations, so it is dragged by the header.
 *
 * A bare `data-tauri-drag-region` drags only when the pressed element *is* the
 * one carrying it. Every page fills the bar with its own full-width wrapper, so
 * the press always landed on a child and the only draggable strip left was the
 * header's outer padding -- the window moved only when the pointer was within a
 * few pixels of the edge. `data-tauri-drag-region="deep"` on the header makes
 * the whole subtree drag instead.
 *
 * These tests assert the behaviour rather than the markup, by resolving a press
 * the same way Tauri does (see tauri/src/window/scripts/drag.js): walk up from
 * the pressed element, stop at the first clickable element or drag-region
 * attribute, and answer from that.
 */

vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: () => ({ open: false, setLeftPanel: vi.fn() }),
}))

vi.mock('@/stores/titlebar-layout-store', () => ({
  useTitlebarLayout: (select: (s: unknown) => unknown) =>
    select({ layout: { left: [], right: [] } }),
}))

const CLICKABLE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'LABEL',
  'SUMMARY',
])
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
])

function isClickable(el: HTMLElement): boolean {
  const role = el.getAttribute('role')
  return (
    CLICKABLE_TAGS.has(el.tagName) ||
    (el.hasAttribute('contenteditable') &&
      el.getAttribute('contenteditable') !== 'false') ||
    (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') ||
    (role !== null && INTERACTIVE_ROLES.has(role))
  )
}

/** Would pressing `pressed` start a window drag? */
function dragsWindow(pressed: HTMLElement): boolean {
  let el: HTMLElement | null = pressed
  while (el) {
    const attr = el.getAttribute('data-tauri-drag-region')
    if (isClickable(el) && attr === null) return false
    if (attr === 'false') return false
    if (attr === 'deep') return true
    if (attr === '' || attr === 'true') return el === pressed
    el = el.parentElement
  }
  return false
}

describe('HeaderPage drag region', () => {
  it('drags when a page fills the bar with its own row', () => {
    render(
      <HeaderPage>
        <PageHeaderRow>
          <span data-testid="label">Jan</span>
        </PageHeaderRow>
      </HeaderPage>
    )

    // The row spans the header end to end. Before the fix it swallowed every
    // press, leaving only the padding draggable.
    const label = screen.getByTestId('label')
    expect(dragsWindow(label)).toBe(true)
    expect(dragsWindow(label.parentElement as HTMLElement)).toBe(true)
  })

  it('drags from the empty stretch and from the bar itself', () => {
    const { container } = render(<HeaderPage />)

    const outer = container.firstElementChild as HTMLElement
    expect(dragsWindow(outer)).toBe(true)

    const stretch = container.querySelector('.flex-1') as HTMLElement
    expect(stretch).toBeTruthy()
    expect(dragsWindow(stretch)).toBe(true)
  })

  /**
   * The other half of the bargain: controls must stay clickable. Tauri stops
   * the upward walk at the first clickable element, so a button inside the deep
   * region keeps its own press.
   */
  it('leaves controls clickable rather than draggable', () => {
    render(<HeaderPage />)
    const toggle = screen.getByLabelText('Toggle sidebar')
    expect(dragsWindow(toggle)).toBe(false)
  })

  /**
   * A bare drag region below the header would answer "is this the pressed
   * element?" with no for any press on a descendant, blocking the walk before
   * it reaches the header's `deep` -- the exact bug this replaced.
   */
  it('declares no bare drag region below the header', () => {
    const { container } = render(
      <HeaderPage>
        <PageHeaderRow>
          <span>Jan</span>
        </PageHeaderRow>
      </HeaderPage>
    )

    const outer = container.firstElementChild as HTMLElement
    expect(outer.getAttribute('data-tauri-drag-region')).toBe('deep')
    expect(outer.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(0)
  })
})
