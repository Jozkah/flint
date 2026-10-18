import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number; branch?: string }) =>
      o?.count != null ? `${k} ${o.count}` : o?.branch != null ? `${k} ${o.branch}` : k,
  }),
}))

import {
  EMPTY_SUMMARY,
  NarrowBarsSheet,
  NarrowStatusStrip,
  summarizeBars,
  type NarrowBarsSummary,
} from '../NarrowStatusStrip'
import { CoworkBarStack } from '../CoworkBarStack'

const act = (name: string, onAct: (n: string) => void) => (
  <button type="button" onClick={() => onAct(name)}>
    {name}
  </button>
)

/** The bars as the Cowork page passes them: trust, review, worktree, a PR. */
function Bars({ onAct, trust = true }: { onAct: (n: string) => void; trust?: boolean }) {
  return (
    <>
      {trust && (
        <section data-testid="folder-trust-banner">
          {act('Not now', onAct)}
          {act('Trust folder', onAct)}
        </section>
      )}
      <CoworkBarStack max={Infinity}>
        <section data-testid="cowork-review-ready">{act('Review changes', onAct)}</section>
        <div data-testid="session-worktree-bar">
          {act('Open folder', onAct)}
          {act('Merge', onAct)}
          {act('Create pull request', onAct)}
          {act('Discard', onAct)}
        </div>
        <div data-testid="pr-bar">PR #12</div>
      </CoworkBarStack>
    </>
  )
}

function Harness({
  waiting = 1,
  trust = true,
  onAct = () => {},
  onWaiting = () => {},
}: {
  waiting?: number
  trust?: boolean
  onAct?: (n: string) => void
  onWaiting?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState<NarrowBarsSummary>(EMPTY_SUMMARY)
  return (
    <div>
      <NarrowStatusStrip
        waiting={waiting}
        summary={summary}
        files={{ count: 2, additions: 19, deletions: 4 }}
        branch="flint/radar-retry"
        onWaiting={onWaiting}
        onOpen={() => setOpen(true)}
      />
      <NarrowBarsSheet open={open} onOpenChange={setOpen} onSummary={setSummary}>
        <Bars onAct={onAct} trust={trust} />
      </NarrowBarsSheet>
    </div>
  )
}

const chipIds = () =>
  [...screen.getByTestId('narrow-status-strip').querySelectorAll('button')].map(
    (b) => b.getAttribute('data-testid')
  )

describe('NarrowStatusStrip', () => {
  it('lists what needs attention in priority order, with counts', async () => {
    render(<Harness />)
    await waitFor(() =>
      expect(chipIds()).toEqual([
        'strip-chip-waiting',
        'strip-chip-trust',
        'strip-chip-files',
        'strip-chip-branch',
        'strip-chip-more',
        'strip-open',
      ])
    )
    expect(screen.getByTestId('strip-chip-waiting')).toHaveTextContent('1')
    expect(screen.getByTestId('strip-chip-files')).toHaveTextContent('2+19 −4')
    expect(screen.getByTestId('strip-chip-more')).toHaveTextContent('+1')
    expect(screen.getByTestId('strip-chip-branch')).toHaveAttribute(
      'aria-label',
      'common:coworkStrip.branch flint/radar-retry'
    )
  })

  it('drops chips for bars that are gone', async () => {
    render(<Harness waiting={0} trust={false} />)
    await waitFor(() =>
      expect(chipIds()).toEqual([
        'strip-chip-files',
        'strip-chip-branch',
        'strip-chip-more',
        'strip-open',
      ])
    )
  })

  it('renders nothing with nothing to show', () => {
    render(
      <NarrowStatusStrip waiting={0} summary={EMPTY_SUMMARY} onOpen={() => {}} />
    )
    expect(screen.queryByTestId('narrow-status-strip')).toBeNull()
  })

  it('keeps the bars parked out of sight until the sheet opens', async () => {
    render(<Harness />)
    await waitFor(() => screen.getByTestId('strip-chip-files'))
    // Mounted (their state lives on) but hidden.
    expect(screen.getByText('Trust folder')).not.toBeVisible()
    expect(screen.queryByTestId('narrow-bars-sheet')).toBeNull()
  })

  it('a chip opens the sheet where every action can be used', async () => {
    const onAct = vi.fn()
    render(<Harness onAct={onAct} />)
    fireEvent.click(await screen.findByTestId('strip-chip-trust'))
    const sheet = await screen.findByTestId('narrow-bars-sheet')
    for (const name of [
      'Trust folder',
      'Not now',
      'Review changes',
      'Open folder',
      'Merge',
      'Create pull request',
      'Discard',
    ]) {
      const button = await within(sheet).findByRole('button', { name })
      fireEvent.click(button)
      expect(onAct).toHaveBeenLastCalledWith(name)
    }
    // Every bar shows in the sheet: nothing behind "Show N more".
    expect(within(sheet).getByTestId('pr-bar')).toBeVisible()
    expect(within(sheet).queryByTestId('cowork-bar-stack-toggle')).toBeNull()
  })

  it('the waiting chip goes to the approval instead of the sheet', async () => {
    const onWaiting = vi.fn()
    render(<Harness onWaiting={onWaiting} />)
    fireEvent.click(await screen.findByTestId('strip-chip-waiting'))
    expect(onWaiting).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('narrow-bars-sheet')).toBeNull()
  })

  it('is reached chip by chip with the keyboard, and Escape closes the sheet', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await waitFor(() => screen.getByTestId('strip-chip-more'))
    const order = [
      'strip-chip-waiting',
      'strip-chip-trust',
      'strip-chip-files',
      'strip-chip-branch',
      'strip-chip-more',
      'strip-open',
    ]
    for (const id of order) {
      await user.tab()
      expect(screen.getByTestId(id)).toHaveFocus()
    }
    await user.keyboard('{Enter}')
    await screen.findByTestId('narrow-bars-sheet')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('narrow-bars-sheet')).toBeNull())
    // The bars are parked again, not unmounted.
    expect(screen.getByText('Trust folder')).not.toBeVisible()
  })

  // jsdom has no layout, so the no-truncation guarantee is structural: every
  // chip keeps its text on one line with no ellipsis, and the row clips
  // rather than wrapping. The pixel check runs in the browser preview.
  it.each([320, 360, 430, 530, 640])('never truncates a chip at %ipx', async (width) => {
    const { container } = render(
      <div style={{ width }}>
        <Harness />
      </div>
    )
    await waitFor(() => screen.getByTestId('strip-chip-more'))
    const strip = screen.getByTestId('narrow-status-strip')
    expect(strip.className).toMatch(/\bh-9\b/)
    for (const chip of strip.querySelectorAll('button')) {
      expect(chip.className).toMatch(/whitespace-nowrap/)
      expect(chip.className).not.toMatch(/\btruncate\b/)
      expect(chip.className).toMatch(/\bshrink-0\b/)
      expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth)
    }
    expect(container.querySelectorAll('[data-testid="narrow-status-strip"]')).toHaveLength(1)
  })
})

describe('summarizeBars', () => {
  it('counts only bars that render', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div data-testid="folder-trust-banner"></div>
      <div data-bar-slot><div data-testid="cowork-review-ready"></div></div>
      <div data-bar-slot></div>
      <div data-bar-slot><div>notice</div></div>`
    expect(summarizeBars(root)).toEqual({ trust: true, files: true, branch: false, more: 1 })
  })
})
