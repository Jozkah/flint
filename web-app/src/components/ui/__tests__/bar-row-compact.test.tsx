import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BarRow, BarRowCompact, primaryAction, type BarAction } from '../bar-row'

const actions = (onSelect: (id: string) => void): BarAction[] => [
  { id: 'open', label: 'Open folder', onSelect: () => onSelect('open'), rank: 0 },
  { id: 'merge', label: 'Merge', onSelect: () => onSelect('merge'), rank: 2, floor: 'icon' },
  { id: 'pr', label: 'Create pull request', onSelect: () => onSelect('pr'), rank: 3, floor: 'icon' },
  { id: 'discard', label: 'Discard', onSelect: () => onSelect('discard'), rank: 1 },
]

function Row({ compact, onSelect }: { compact: boolean; onSelect: (id: string) => void }) {
  return (
    <BarRowCompact value={compact}>
      <BarRow
        testId="row"
        lead="flint/radar-retry"
        actions={actions(onSelect)}
        trailing={<button type="button">dismiss-x</button>}
        trailingAction={{ id: 'hide', label: 'Hide', onSelect: () => onSelect('hide') }}
      />
    </BarRowCompact>
  )
}

describe('BarRow, compact', () => {
  it('keeps the highest-ranked action, or the one marked primary', () => {
    expect(primaryAction(actions(() => {}))?.id).toBe('pr')
    const marked = actions(() => {}).map((a) => (a.id === 'open' ? { ...a, primary: true } : a))
    expect(primaryAction(marked)?.id).toBe('open')
  })

  it('shows one action and puts every other one, the dismissal too, in "..."', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Row compact onSelect={onSelect} />)
    const row = screen.getByTestId('row')
    const inRow = [...row.querySelectorAll('[data-bar-action]')].map((b) => b.textContent)
    expect(inRow).toEqual(['Create pull request'])
    expect(within(row).queryByText('dismiss-x')).toBeNull()
    await user.click(screen.getByTestId('row-more'))
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
    expect(items).toEqual(['Open folder', 'Merge', 'Discard', 'Hide'])
    await user.click(screen.getByRole('menuitem', { name: 'Hide' }))
    expect(onSelect).toHaveBeenCalledWith('hide')
  })

  it('outside the sheet the row is unchanged: its dismiss stays a button', () => {
    render(<Row compact={false} onSelect={() => {}} />)
    expect(screen.getByText('dismiss-x')).toBeInTheDocument()
  })

  // jsdom lays nothing out: the 8px rule is the row's even padding (px-2.5 =
  // 10px, px-3 = 12px compact) on the side where the last action sits. The
  // browser check measured it at 320/360/430/700 and fonts 14/16/20.
  it.each([false, true])('keeps at least 8px between the last control and the edge (compact %s)', (compact) => {
    render(<Row compact={compact} onSelect={() => {}} />)
    const cls = screen.getByTestId('row').className
    expect(cls).toMatch(compact ? /\bpx-3\b/ : /\bpx-2\.5\b/)
    expect(cls).not.toMatch(/\bpr-(0|1|1\.5)\b/)
  })
})
