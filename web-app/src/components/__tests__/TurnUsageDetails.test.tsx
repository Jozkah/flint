import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TurnUsageDetails } from '../TurnUsageDetails'

describe('TurnUsageDetails', () => {
  it('shows this turn’s breakdown and the memory ids its request carried', async () => {
    const user = userEvent.setup()
    render(
      <TurnUsageDetails
        usage={{
          inputTokens: 5542,
          cachedInputTokens: 5505,
          uncachedInputTokens: 37,
          outputTokens: 17,
          totalTokens: 5559,
        }}
        memory={{ injectedIds: ['mem-a', 'mem-b'], conflictIds: ['mem-x'] }}
      />
    )
    const trigger = screen.getByTestId('turn-usage-trigger')
    // Grouped in the reader's locale, so derived rather than hard-coded.
    expect(trigger.textContent).toContain((5559).toLocaleString())
    expect(trigger.textContent).toContain('2 memories')
    await user.click(trigger)
    expect(
      screen.getByTestId('turn-token-usage-cached').getAttribute('data-value')
    ).toBe('5505')
    const ids = [...document.querySelectorAll('[data-memory-id]')].map((e) =>
      e.getAttribute('data-memory-id')
    )
    expect(ids).toEqual(['mem-a', 'mem-b'])
    expect(screen.getByTestId('turn-memory-withheld').textContent).toContain('mem-x')
  })

  it('is keyboard reachable', async () => {
    const user = userEvent.setup()
    render(<TurnUsageDetails usage={{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }} />)
    await user.tab()
    expect(document.activeElement).toBe(screen.getByTestId('turn-usage-trigger'))
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('turn-usage-details')).toBeTruthy()
  })

  it('says why each memory was sent, and shows storage problems and recall that was off', async () => {
    render(
      <TurnUsageDetails
        memory={{
          injectedIds: ['mem-a'],
          conflictIds: [],
          recall: [{ id: 'mem-a', rank: 1, reason: 'applies to this user' }],
          recallOff: ['project'],
          storageIssues: ['user.jsonl: 1 damaged record(s) were skipped'],
        }}
      />
    )
    await userEvent.click(screen.getByTestId('turn-usage-trigger'))
    expect(await screen.findByTestId('turn-memory-reason')).toHaveTextContent('#1 · applies to this user')
    expect(screen.getByTestId('turn-memory-recall-off')).toHaveTextContent('project')
    expect(screen.getByTestId('turn-memory-storage-error')).toHaveTextContent('damaged')
  })

  it('shows a memory held back by a higher source with both sides, and a refused one (AH-084)', async () => {
    render(
      <TurnUsageDetails
        memory={{
          injectedIds: [],
          conflictIds: [],
          overridden: [
            {
              memoryId: 'mem-npm',
              subject: 'package manager',
              memorySays: 'Install dependencies with npm',
              winner: 'jan-md',
              winnerName: 'JAN.md',
              winnerSays: 'Install dependencies with pnpm',
            },
          ],
          refused: [{ memoryId: 'mem-evil', reason: 'tries to override earlier instructions' }],
        }}
      />
    )
    await userEvent.click(screen.getByTestId('turn-usage-trigger'))
    const o = await screen.findByTestId('turn-memory-overridden')
    expect(o).toHaveAttribute('data-memory-id', 'mem-npm')
    expect(o).toHaveTextContent('disagrees with JAN.md about the package manager')
    expect(o).toHaveTextContent('with npm')
    expect(o).toHaveTextContent('with pnpm')
    expect(screen.getByTestId('turn-memory-refused')).toHaveTextContent(
      'mem-evil tries to override earlier instructions'
    )
  })

  it('renders nothing when the turn reported neither usage nor memory', () => {
    const { container } = render(<TurnUsageDetails />)
    expect(container.firstChild).toBeNull()
  })
})
