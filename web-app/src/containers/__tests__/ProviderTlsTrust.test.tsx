import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const h = vi.hoisted(() => ({ updateProvider: vi.fn() }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (select: (s: { updateProvider: unknown }) => unknown) =>
    select({ updateProvider: h.updateProvider }),
}))

import { ProviderTlsTrust } from '../ProviderTlsTrust'

const provider = (allow?: boolean) =>
  ({
    provider: 'gateway',
    active: true,
    models: [],
    settings: [],
    allow_invalid_certs: allow,
  }) as ModelProvider

describe('ProviderTlsTrust', () => {
  beforeEach(() => h.updateProvider.mockReset())

  it('is off by default and shows no warning', () => {
    render(<ProviderTlsTrust provider={provider()} />)
    expect(screen.getByTestId('tls-trust-switch').getAttribute('data-state')).toBe(
      'unchecked'
    )
    expect(screen.queryByTestId('tls-trust-warning')).toBeNull()
  })

  it('turns on for this provider only', () => {
    render(<ProviderTlsTrust provider={provider()} />)
    fireEvent.click(screen.getByTestId('tls-trust-switch'))
    expect(h.updateProvider).toHaveBeenCalledWith('gateway', {
      allow_invalid_certs: true,
    })
  })

  it('keeps the warning visible while it is on', () => {
    render(<ProviderTlsTrust provider={provider(true)} />)
    expect(screen.getByTestId('tls-trust-warning').textContent).toContain(
      'providers:tlsTrust.warning'
    )
  })
})
