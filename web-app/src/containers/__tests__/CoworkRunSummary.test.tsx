import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { CoworkRunSummary } from '../CoworkRunSummary'
import type { CompletionSummary } from '@/lib/coworkOrigins'

const empty: CompletionSummary = {
  janWrites: [],
  janWritesOverExisting: [],
  preExisting: [],
  observed: [],
  unknown: [],
  baseline: 'clean',
}

const show = (over: Partial<CompletionSummary> = {}) =>
  render(<CoworkRunSummary summary={{ ...empty, ...over }} />)

const region = () => screen.getByTestId('cowork-run-summary')

describe('the run summary the application writes', () => {
  it('says what Jan changed, and where', () => {
    show({
      janWrites: [
        { destination: 'repository', paths: ['src/a.ts'] },
        { destination: 'sandbox', paths: ['notes.md'] },
      ],
    })

    expect(region()).toHaveTextContent(
      'common:coworkOrigins.janWrites.repository'
    )
    expect(region()).toHaveTextContent('src/a.ts')
    expect(region()).toHaveTextContent('common:coworkOrigins.janWrites.sandbox')
    expect(region()).toHaveTextContent('notes.md')
  })

  // The distinction the whole ledger exists to preserve.
  it('keeps what Jan did apart from what was merely found', () => {
    show({
      janWrites: [{ destination: 'repository', paths: ['mine.ts'] }],
      observed: ['built.js'],
      preExisting: ['theirs.ts'],
      unknown: ['nowhere.ts'],
    })

    expect(region()).toHaveTextContent('common:coworkOrigins.observed')
    expect(region()).toHaveTextContent('common:coworkOrigins.preExisting')
    expect(region()).toHaveTextContent('common:coworkOrigins.unknown')
  })

  it('reports both facts about a write over existing changes', () => {
    show({
      janWrites: [{ destination: 'repository', paths: ['a.ts'] }],
      janWritesOverExisting: ['a.ts'],
    })

    expect(region()).toHaveTextContent('common:coworkOrigins.overExisting')
  })

  // A run that changed nothing says so, rather than showing an empty frame the
  // reader has to interpret.
  it('says plainly when nothing was changed', () => {
    show()

    expect(region()).toHaveTextContent('common:coworkOrigins.nothing')
  })

  it.each([
    'clean',
    'dirty',
    'non-git',
    'git-unavailable',
    'incomplete',
    'none',
  ] as const)('names the %s starting state it compared against', (baseline) => {
    show({ baseline })

    expect(region()).toHaveTextContent(`common:coworkOrigins.baseline.${baseline}`)
  })

  // Its own labelled region, not a paragraph inside the assistant's message:
  // the reader has to be able to tell which of the two wrote it.
  it('stands apart from the model’s prose as its own region', () => {
    show({ janWrites: [{ destination: 'repository', paths: ['a.ts'] }] })
    const section = screen.getByRole('region', {
      name: 'common:coworkOrigins.title',
    })

    expect(section).toBe(region())
    expect(within(section).getByText('common:coworkOrigins.subtitle')).toBeInTheDocument()
  })

  it('opens closed, so it does not reopen in full under every message', () => {
    show()
    const disclosure = region().querySelector('details')
    expect(disclosure).not.toBeNull()
    expect(disclosure).not.toHaveAttribute('open')
    // The heading still names it while collapsed, so it can be found.
    expect(region()).toHaveTextContent('common:coworkOrigins.title')
  })
})
