import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { CoworkRunSettings } from '../CoworkRunSettings'

describe('CoworkRunSettings', () => {
  it('keeps its controls collapsed until opened', async () => {
    render(
      <CoworkRunSettings exceptions={[]}>
        <button>inner</button>
      </CoworkRunSettings>
    )
    expect(screen.queryByText('inner')).toBeNull()
    await userEvent.click(screen.getByTestId('cowork-run-settings'))
    expect(screen.getByText('inner')).toBeInTheDocument()
  })

  it('names non-default settings beside the closed trigger', () => {
    render(
      <CoworkRunSettings
        exceptions={[
          { id: 'mode', label: 'Autonomous', warn: true },
          { id: 'effort', label: 'Effort: high' },
        ]}
      >
        <button>inner</button>
      </CoworkRunSettings>
    )
    expect(screen.getByTestId('cowork-run-exception-mode')).toHaveTextContent('Autonomous')
    expect(screen.getByTestId('cowork-run-exception-effort')).toHaveTextContent('Effort: high')
    expect(screen.queryByText('inner')).toBeNull()
  })
})
