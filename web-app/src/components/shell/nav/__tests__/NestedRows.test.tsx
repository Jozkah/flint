import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { count?: number }) =>
      o?.count === undefined ? key : `${key.split('.').pop()} ${o.count}`,
  }),
}))

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { NestedRows } from '../NestedRows'
import { useNestExpanded } from '@/stores/nest-expanded-store'
import type { NestStatus } from '@/lib/nesting'

type Row = { id: string; parent?: string; updated: number; status?: NestStatus }

function setup(rows: Row[], selectedId?: string) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return render(
    <ul>
      <NestedRows
        scope="chats"
        ids={rows.map((r) => r.id)}
        parentOf={(id) => byId.get(id)?.parent}
        updatedOf={(id) => byId.get(id)?.updated ?? 0}
        statusOf={(id) => byId.get(id)?.status ?? 'none'}
        selectedId={selectedId}
        renderRow={(id) => (
          <li key={id} data-testid={`row-${id}`}>
            <button type="button" data-slot="nav-button">
              {id}
            </button>
          </li>
        )}
      />
    </ul>
  )
}

/** A parent `p` with `n` forks, newest first: c0 is the newest. */
function family(n: number, status: (i: number) => NestStatus = () => 'none'): Row[] {
  return [
    { id: 'p', updated: 0 },
    ...Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      parent: 'p',
      updated: 1000 - i,
      status: status(i),
    })),
  ]
}

const shownChildren = () =>
  screen
    .queryAllByTestId('nest-child')
    .filter((li) => !li.closest('[inert]'))
    .map((li) => li.querySelector('[data-testid^="row-"]')?.textContent)
    .filter(Boolean)

beforeEach(() => {
  localStorage.clear()
  useNestExpanded.setState({ expanded: {} })
})

describe('NestedRows', () => {
  it('renders rows without parents unchanged', () => {
    setup([
      { id: 'a', updated: 2 },
      { id: 'b', updated: 1 },
    ])
    expect(screen.getByTestId('row-a')).toBeInTheDocument()
    expect(screen.queryByTestId('nest-parent')).toBeNull()
    expect(screen.queryByTestId('nest-summary')).toBeNull()
  })

  it('nests up to three rows without a summary', () => {
    setup(family(2))
    expect(screen.getByTestId('nest-parent')).toHaveAttribute('data-nest-id', 'p')
    expect(shownChildren()).toEqual(['c0', 'c1'])
    expect(screen.queryByTestId('nest-summary')).toBeNull()
    expect(screen.getByTestId('nest-count')).toHaveTextContent('2')
  })

  it('folds the rest behind one summary row with the counts', () => {
    setup(
      family(20, (i) => (i >= 3 && i < 15 ? 'recent' : i >= 15 && i < 19 ? 'active' : 'none'))
    )
    // c15..c18 are working: they stay in view, out of the summary.
    expect(shownChildren()).toEqual(['c0', 'c1', 'c2', 'c15', 'c16', 'c17', 'c18'])
    const summary = screen.getByTestId('nest-summary')
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    // 13 hidden: c3..c14 (12 new) and c19.
    expect(summary).toHaveAttribute('aria-label', 'more 13, new 12')
    expect(summary).toHaveTextContent('more 13·new 12')
  })

  it('keeps a waiting row in view and counts only what it hides', () => {
    setup(family(6, (i) => (i === 5 ? 'wait' : i === 4 ? 'recent' : 'none')))
    expect(shownChildren()).toEqual(['c0', 'c1', 'c2', 'c5'])
    expect(screen.getByTestId('nest-summary')).toHaveAttribute('aria-label', 'more 2, new 1')
  })

  it('never hides the selected row', () => {
    setup(family(10), 'c8')
    expect(shownChildren()).toContain('c8')
  })

  it('toggles with the keyboard and remembers the choice', () => {
    const { unmount } = setup(family(8))
    const summary = screen.getByTestId('nest-summary')
    expect(summary.tagName).toBe('BUTTON')
    summary.focus()
    expect(summary).toHaveFocus()
    // A native button: Enter and Space fire click.
    fireEvent.click(summary)
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    expect(shownChildren()).toHaveLength(8)
    expect(useNestExpanded.getState().expanded['chats:p']).toBe(true)
    expect(localStorage.getItem('flint-nested-expanded')).toContain('chats:p')
    unmount()
    setup(family(8))
    expect(screen.getByTestId('nest-summary')).toHaveAttribute('aria-expanded', 'true')
    act(() => fireEvent.click(screen.getByTestId('nest-summary')))
    expect(screen.getByTestId('nest-summary')).toHaveAttribute('aria-expanded', 'false')
    expect(shownChildren()).toHaveLength(3)
  })

  it('keeps every nested row a focusable list row for arrow navigation', () => {
    setup(family(5))
    const buttons = within(document.body)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-slot') === 'nav-button' && !b.closest('[inert]'))
    // parent, three nested, the summary
    expect(buttons).toHaveLength(5)
  })

  it('promotes the children when the parent is deleted', () => {
    const rows = family(5)
    const { unmount } = setup(rows)
    expect(screen.getByTestId('nest-parent')).toBeInTheDocument()
    unmount()
    setup(rows.filter((r) => r.id !== 'p'))
    expect(screen.queryByTestId('nest-parent')).toBeNull()
    expect(screen.queryByTestId('nest-summary')).toBeNull()
    for (let i = 0; i < 5; i++) expect(screen.getByTestId(`row-c${i}`)).toBeInTheDocument()
  })
})
