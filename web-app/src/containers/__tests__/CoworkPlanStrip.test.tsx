import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o ? `${k} ${JSON.stringify(o)}` : k,
  }),
}))

import { CoworkPlanStrip } from '../CoworkPlanStrip'

const plan = {
  phases: [
    {
      name: '',
      tasks: [
        { content: 'Read the page', status: 'completed' as const },
        { content: '[x] Add the form', status: 'in_progress' as const },
        { content: 'Update the README', status: 'pending' as const },
      ],
    },
  ],
}

describe('the plan strip', () => {
  it('renders nothing without a plan', () => {
    const { container } = render(<CoworkPlanStrip todos={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('counts done steps and marks the current one without the running look', () => {
    render(<CoworkPlanStrip todos={plan} />)
    expect(screen.getByTestId('cowork-plan-count')).toHaveTextContent(
      '"done":1,"total":3'
    )
    const current = screen.getByText('Add the form').closest('li')
    expect(current).toHaveAttribute('aria-current', 'step')
    expect(current?.className).toMatch(/border-brand/)
    // Selection, not activity: nothing in the strip spins.
    expect(
      screen.getByTestId('cowork-plan-strip').querySelector('.animate-spin, [class*="animate-"]')
    ).toBeNull()
  })

  it('collapses to its header', async () => {
    render(<CoworkPlanStrip todos={plan} />)
    await userEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByText('Read the page')).toBeNull()
  })
})
