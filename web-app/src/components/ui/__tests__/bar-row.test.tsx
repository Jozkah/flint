import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FolderOpen, GitMerge, GitPullRequest, Trash2 } from 'lucide-react'
import { BarRow, collapseSteps, type BarAction } from '../bar-row'

// jsdom lays nothing out, so the row's widths are modelled: the box is the
// container's width, the content is what its children would take.
let boxWidth = 900
const observers: ResizeObserverCallback[] = []

function contentWidth(row: HTMLElement) {
  let w = 24 // padding
  for (const child of Array.from(row.children) as HTMLElement[]) {
    if (child.hasAttribute('data-bar-action'))
      w += child.textContent ? child.textContent.length * 7 + 40 : 28
    else if (child.classList.contains('text-fade')) w += 96 // its 6em floor
    else if (child.tagName === 'BUTTON') w += 28
    else if (child.tagName.toLowerCase() === 'svg') w += 16
    else w += (child.textContent ?? '').length * 7
    w += 8 // gap
  }
  return w
}

const desc = (key: 'clientWidth' | 'scrollWidth') =>
  Object.getOwnPropertyDescriptor(Element.prototype, key)!
const saved = { clientWidth: desc('clientWidth'), scrollWidth: desc('scrollWidth') }

beforeEach(() => {
  boxWidth = 900
  observers.length = 0
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-bar-row') ? boxWidth : 0
    },
  })
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-bar-row') ? contentWidth(this) : 0
    },
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(cb)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  Object.defineProperty(Element.prototype, 'clientWidth', saved.clientWidth)
  Object.defineProperty(Element.prototype, 'scrollWidth', saved.scrollWidth)
  vi.unstubAllGlobals()
})

const resize = (width: number) =>
  act(() => {
    boxWidth = width
    observers.forEach((cb) => cb([], {} as ResizeObserver))
  })

const worktreeActions = (spy = vi.fn()): BarAction[] => [
  { id: 'open', label: 'Open folder', icon: <FolderOpen />, onSelect: () => spy('open'), rank: 0 },
  { id: 'merge', label: 'Merge', icon: <GitMerge />, onSelect: () => spy('merge'), rank: 2, floor: 'icon' },
  { id: 'pr', label: 'Create pull request', icon: <GitPullRequest />, onSelect: () => spy('pr'), rank: 3, floor: 'icon' },
  { id: 'discard', label: 'Discard', icon: <Trash2 />, onSelect: () => spy('discard'), rank: 1, testId: 'discard' },
]

/** Each action's form on screen: label, icon, or absent (in the menu). */
function forms() {
  const out: Record<string, string> = {}
  for (const id of ['open', 'merge', 'pr', 'discard']) {
    const el = document.querySelector(`[data-bar-action="${id}"]`)
    out[id] = !el ? 'menu' : el.textContent ? 'label' : 'icon'
  }
  return out
}

const menu = () => screen.queryByTestId('bar-more')

describe('BarRow', () => {
  it('collapses the actions that may leave the row first, the kept ones last', () => {
    const steps = collapseSteps(worktreeActions())
    expect(steps[0]).toEqual({ open: 'label', merge: 'label', pr: 'label', discard: 'label' })
    expect(steps.at(-1)).toEqual({ open: 'menu', merge: 'icon', pr: 'icon', discard: 'menu' })
    // Open folder and Discard are in the menu before Merge loses its label.
    const mergeIcon = steps.findIndex((s) => s.merge === 'icon')
    expect(steps[mergeIcon - 1]).toMatchObject({ open: 'menu', discard: 'menu', merge: 'label' })
  })

  it.each([
    [900, { open: 'label', merge: 'label', pr: 'label', discard: 'label' }, false],
    [600, { open: 'icon', merge: 'label', pr: 'label', discard: 'label' }, false],
    [420, { open: 'menu', merge: 'icon', pr: 'label', discard: 'menu' }, true],
    [320, { open: 'menu', merge: 'icon', pr: 'icon', discard: 'menu' }, true],
  ])('at %ipx keeps one row: %o', async (width, expected, hasMenu) => {
    boxWidth = width
    render(
      <BarRow testId="bar" lead="flint/radar-retry" actions={worktreeActions()} />
    )
    await waitFor(() => expect(forms()).toEqual(expected))
    expect(!!menu()).toBe(hasMenu)
    const row = screen.getByTestId('bar')
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
    expect(row).toHaveClass('flex-nowrap', 'overflow-hidden')
  })

  it.each([1500, 1000, 700, 560, 480, 420, 400, 360, 320, 240])(
    'at %ipx never overflows and stays one fixed-height row',
    async (width) => {
      boxWidth = width
      render(<BarRow testId="bar" lead="flint/radar-retry" actions={worktreeActions()} />)
      const row = screen.getByTestId('bar')
      await waitFor(() => expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth))
      expect(row).toHaveClass('h-9', 'flex-nowrap', 'overflow-hidden')
    }
  )

  it('collapses as the pane narrows and comes back as it widens', async () => {
    render(<BarRow testId="bar" lead="flint/radar-retry" actions={worktreeActions()} />)
    await waitFor(() => expect(forms().open).toBe('label'))
    resize(320)
    await waitFor(() => expect(forms().pr).toBe('icon'))
    resize(900)
    await waitFor(() =>
      expect(forms()).toEqual({ open: 'label', merge: 'label', pr: 'label', discard: 'label' })
    )
    expect(menu()).toBeNull()
  })

  it('names icon-only actions for screen readers', async () => {
    boxWidth = 600
    render(<BarRow testId="bar" lead="x" actions={worktreeActions()} />)
    await waitFor(() => expect(forms().open).toBe('icon'))
    expect(
      document.querySelector('[data-bar-action="open"]')!.getAttribute('aria-label')
    ).toBe('Open folder')
  })

  it('fires an action chosen from the "..." menu', async () => {
    boxWidth = 320
    const spy = vi.fn()
    render(<BarRow testId="bar" lead="x" actions={worktreeActions(spy)} />)
    await waitFor(() => expect(menu()).not.toBeNull())
    await userEvent.click(menu()!)
    await userEvent.click(await screen.findByTestId('discard-menu'))
    expect(spy).toHaveBeenCalledWith('discard')
  })

  it('never collapses an action below its floor', async () => {
    boxWidth = 120
    render(
      <BarRow
        testId="bar"
        lead="Trust this folder? Its hooks run commands"
        actions={[
          { id: 'later', label: 'Not now', icon: <Trash2 />, onSelect: () => {}, floor: 'icon' },
          { id: 'trust', label: 'Trust folder', onSelect: () => {}, floor: 'label', rank: 1 },
        ]}
      />
    )
    await waitFor(() =>
      expect(document.querySelector('[data-bar-action="later"]')!.textContent).toBe('')
    )
    expect(document.querySelector('[data-bar-action="trust"]')).toHaveTextContent('Trust folder')
    expect(menu()).toBeNull()
  })
})
