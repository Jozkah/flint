import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) =>
      o?.count != null ? `${k} ${o.count}` : k,
  }),
}))

import {
  EMPTY_SUMMARY,
  NarrowBarsSheet,
  NarrowStatusStrip,
  attentionCount,
  summarizeBars,
  type NarrowBarsSummary,
} from '../NarrowStatusStrip'
import { CoworkBarStack } from '../CoworkBarStack'

/** What the shared-folder bar leaves in the DOM for the strip to read. */
function SharedBar({ urgent = false }: { urgent?: boolean }) {
  return (
    <div
      data-testid="shared-folder-bar"
      data-shared-label={urgent ? 'Fix auth is editing src/x.ts' : '2 other sessions'}
      data-shared-urgent={urgent ? '' : undefined}
      data-shared-count="2"
    >
      row
    </div>
  )
}

function Harness({
  shared = true,
  urgent = false,
  pr = false,
  waiting = 0,
  condensed = false,
}: {
  shared?: boolean
  urgent?: boolean
  pr?: boolean
  waiting?: number
  condensed?: boolean
}) {
  const [summary, setSummary] = useState<NarrowBarsSummary>(EMPTY_SUMMARY)
  return (
    <div>
      {/* As the Cowork page does: a strip only from two items up. */}
      {(attentionCount(waiting, summary) >= 2) && (
        <NarrowStatusStrip
          waiting={waiting}
          summary={summary}
          onOpen={() => {}}
          condensed={condensed}
        />
      )}
      <output data-testid="count">{attentionCount(waiting, summary)}</output>
      <NarrowBarsSheet
        open={false}
        inline={attentionCount(waiting, summary) < 2 && waiting === 0}
        onOpenChange={() => {}}
        onSummary={setSummary}
      >
        <CoworkBarStack max={Infinity}>
          {pr ? <div data-testid="pr-bar">PR #12</div> : null}
          {shared ? <SharedBar urgent={urgent} /> : null}
        </CoworkBarStack>
      </NarrowBarsSheet>
    </div>
  )
}

const chipIds = () =>
  [...screen.getByTestId('narrow-status-strip').querySelectorAll('button')].map(
    (b) => b.getAttribute('data-testid')
  )

describe('the shared-folder bar in the narrow status strip', () => {
  it('reads the bar, and does not also count it among the other bars', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div data-bar-slot><div data-testid="shared-folder-bar" data-shared-label="x" data-shared-urgent data-shared-count="3"></div></div>' +
      '<div data-bar-slot><div data-testid="pr-bar"></div></div>'
    expect(summarizeBars(root)).toMatchObject({
      shared: { label: 'x', urgent: true, count: 3 },
      more: 1,
    })
  })

  it('alone it is just a row: no strip', async () => {
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
    expect(screen.queryByTestId('narrow-status-strip')).toBeNull()
    // The bar stays on screen where it stands.
    expect(screen.getByTestId('shared-folder-bar')).toBeVisible()
  })

  it('with a second bar, both fold into one strip with a chip for it', async () => {
    render(<Harness pr />)
    await waitFor(() =>
      expect(chipIds()).toEqual(['strip-chip-shared', 'strip-chip-more', 'strip-open'])
    )
    expect(screen.getByTestId('strip-chip-shared')).toHaveTextContent('2')
    expect(screen.getByTestId('strip-chip-more')).toHaveTextContent('+1')
    // No new stacked bar: the row is parked with the others.
    expect(screen.getByTestId('shared-folder-bar')).not.toBeVisible()
  })

  it('an urgent item leads the named chips; a calm one comes last', async () => {
    const { rerender } = render(<Harness waiting={1} urgent />)
    await waitFor(() =>
      expect(chipIds().slice(0, 2)).toEqual(['strip-chip-waiting', 'strip-chip-shared'])
    )
    rerender(<Harness waiting={1} />)
    await waitFor(() => expect(chipIds()).toContain('strip-chip-shared'))
    expect(screen.getByTestId('strip-chip-shared')).not.toHaveClass('text-warning')
  })

  it('on a phone only the most urgent item shows, with its words', async () => {
    render(<Harness pr urgent condensed />)
    await waitFor(() => expect(chipIds()[0]).toBe('strip-chip-shared'))
    expect(screen.getByTestId('strip-chip-shared')).toHaveTextContent(
      'Fix auth is editing src/x.ts'
    )
    expect(screen.getByTestId('strip-chip-shared')).toHaveClass('text-warning')
    expect(screen.getByTestId('strip-chip-more')).toHaveTextContent('+1')
  })
})
