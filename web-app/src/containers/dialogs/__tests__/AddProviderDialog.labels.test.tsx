/**
 * Every field of the add-provider dialog has a programmatic label, and a probe
 * that rejects does not leave an unhandled rejection behind.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('@/lib/localProviderProbe', () => ({
  probeLocalProviders: () => Promise.reject(new Error('refused')),
}))

import { AddProviderDialog } from '../AddProviderDialog'

describe('AddProviderDialog labels', () => {
  it('binds each label to its control', async () => {
    render(
      <AddProviderDialog onCreateProvider={vi.fn()}>
        <button>open</button>
      </AddProviderDialog>
    )
    fireEvent.click(screen.getByText('open'))
    await waitFor(() =>
      expect(screen.getByLabelText('provider:nameLabel')).toBeInTheDocument()
    )
    expect(screen.getByLabelText('provider:baseUrlLabel')).toBeInTheDocument()
    expect(screen.getByLabelText('provider:apiKeyLabel')).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: 'provider:apiTypeLabel' })
    ).toBeInTheDocument()
  })
})
