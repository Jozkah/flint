import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k} ${Object.values(opts).join(' ')}` : k,
  }),
}))

import { CoworkChangesChip } from '../CoworkChangesChip'

describe('CoworkChangesChip', () => {
  // Same rule as the plan and folder controls: nothing changed anywhere is
  // nothing to say, so the dock row stays quiet.
  it('renders nothing when neither source has changes', () => {
    const { container } = render(
      <CoworkChangesChip
        fileCount={0}
        additions={0}
        deletions={0}
        open={false}
        onToggle={vi.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the combined counts across both change sources', () => {
    render(
      <CoworkChangesChip
        fileCount={3}
        additions={7}
        deletions={7}
        open={false}
        onToggle={vi.fn()}
      />
    )
    expect(screen.getByText('+7')).toBeInTheDocument()
    expect(screen.getByText('-7')).toBeInTheDocument()
  })

  it('reports its state and toggles the rail', async () => {
    const onToggle = vi.fn()
    render(
      <CoworkChangesChip
        fileCount={1}
        additions={1}
        deletions={0}
        open={true}
        onToggle={onToggle}
      />
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(button)
    expect(onToggle).toHaveBeenCalledOnce()
  })
})
