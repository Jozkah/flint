import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  updateProvider: vi.fn(),
  store: vi.fn(async () => {}),
  toastError: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      opts?.error ? `${key}: ${opts.error}` : key,
  }),
}))
vi.mock('sonner', () => ({ toast: { error: h.toastError } }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (select: (s: { updateProvider: unknown }) => unknown) =>
    select({ updateProvider: h.updateProvider }),
}))
vi.mock('@/lib/providerHeaderSecrets', () => ({
  storeSecretHeaderValues: h.store,
}))

import { ProviderCustomHeaders } from '../ProviderCustomHeaders'

const SECRET = 'secret-value-never-shown'

const provider = (custom_header: ProviderCustomHeader[] = []) =>
  ({
    provider: 'gateway',
    active: true,
    models: [],
    settings: [],
    custom_header,
  }) as ModelProvider

const type = (testId: string, value: string) => {
  const input = screen.getByTestId(testId)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

describe('ProviderCustomHeaders', () => {
  beforeEach(() => {
    h.updateProvider.mockReset()
    h.store.mockReset()
    h.store.mockResolvedValue(undefined)
    h.toastError.mockReset()
  })

  it('saves a sound header, its secret value to the credential store first', async () => {
    render(<ProviderCustomHeaders provider={provider()} />)
    fireEvent.click(screen.getByTestId('custom-header-add'))
    type('custom-header-name-0', 'Ocp-Apim-Subscription-Key')
    type('custom-header-value-0', SECRET)

    await waitFor(() => expect(h.updateProvider).toHaveBeenCalled())
    const rows = [
      { header: 'Ocp-Apim-Subscription-Key', value: SECRET, secret: true },
    ]
    // A key-like name defaults to secret.
    expect(h.store).toHaveBeenCalledWith('gateway', rows)
    expect(h.updateProvider).toHaveBeenCalledWith('gateway', {
      custom_header: rows,
    })
    expect(h.store.mock.invocationCallOrder[0]).toBeLessThan(
      h.updateProvider.mock.invocationCallOrder[0]
    )
  })

  it('shows why a header cannot be saved, and does not save it', async () => {
    render(<ProviderCustomHeaders provider={provider()} />)
    fireEvent.click(screen.getByTestId('custom-header-add'))
    type('custom-header-name-0', 'Authorization')
    type('custom-header-value-0', 'Bearer spoofed')

    expect(screen.getByTestId('custom-header-error-0').textContent).toBe(
      'providers:customHeaders.errors.reserved'
    )
    expect(screen.getByTestId('custom-header-name-0')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(h.store).not.toHaveBeenCalled()
    expect(h.updateProvider).not.toHaveBeenCalled()
  })

  it('names the duplicate row, not the first', () => {
    render(
      <ProviderCustomHeaders
        provider={provider([{ header: 'X-Tenant', value: 'a' }])}
      />
    )
    fireEvent.click(screen.getByTestId('custom-header-add'))
    type('custom-header-name-1', 'x-tenant')
    type('custom-header-value-1', 'b')
    expect(screen.queryByTestId('custom-header-error-0')).toBeNull()
    expect(screen.getByTestId('custom-header-error-1').textContent).toBe(
      'providers:customHeaders.errors.duplicate'
    )
  })

  it('does not report a header saved when its secret could not be stored', async () => {
    h.store.mockRejectedValue(new Error(`keyring refused ${SECRET}`))
    render(<ProviderCustomHeaders provider={provider()} />)
    fireEvent.click(screen.getByTestId('custom-header-add'))
    type('custom-header-name-0', 'X-Auth-Token')
    type('custom-header-value-0', SECRET)

    await waitFor(() => expect(h.toastError).toHaveBeenCalled())
    expect(h.updateProvider).not.toHaveBeenCalled()
    // The error is shown, the secret in it is not.
    const shown = JSON.stringify(h.toastError.mock.calls)
    expect(shown).toContain('keyring refused')
    expect(shown).not.toContain(SECRET)
  })

  it('masks a secret value and shows a plain one', () => {
    render(
      <ProviderCustomHeaders
        provider={provider([
          { header: 'X-Tenant', value: 'acme' },
          { header: 'X-Key', value: SECRET, secret: true },
        ])}
      />
    )
    expect(screen.getByTestId('custom-header-value-0')).not.toHaveAttribute(
      'type',
      'password'
    )
    expect(screen.getByTestId('custom-header-value-1')).toHaveAttribute(
      'type',
      'password'
    )
  })

  it('saves without a row once it is removed', async () => {
    render(
      <ProviderCustomHeaders
        provider={provider([
          { header: 'X-Tenant', value: 'acme' },
          { header: 'X-Region', value: 'eu' },
        ])}
      />
    )
    fireEvent.click(screen.getByTestId('custom-header-remove-0'))
    await waitFor(() =>
      expect(h.updateProvider).toHaveBeenCalledWith('gateway', {
        custom_header: [{ header: 'X-Region', value: 'eu' }],
      })
    )
  })
})
