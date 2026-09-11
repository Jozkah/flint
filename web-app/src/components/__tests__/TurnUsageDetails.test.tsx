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

  it('renders nothing when the turn reported neither usage nor memory', () => {
    const { container } = render(<TurnUsageDetails />)
    expect(container.firstChild).toBeNull()
  })
})
