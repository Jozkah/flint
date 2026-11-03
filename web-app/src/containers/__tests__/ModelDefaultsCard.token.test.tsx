import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const store = vi.hoisted(() => ({ token: 'hf_abc' }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      huggingfaceToken: store.token,
      setHuggingfaceToken: (v: string) => {
        store.token = v
      },
      downloadLimitMBps: 0,
      setDownloadLimitMBps: vi.fn(),
    }),
}))
vi.mock('@/containers/FallbackModelsPicker', () => ({ default: () => null }))
vi.mock('@/containers/HfEndpointSetting', () => ({ HfEndpointSetting: () => null }))

import { ModelDefaultsCard } from '../ModelDefaultsCard'

describe('ModelDefaultsCard token check', () => {
  beforeEach(() => {
    store.token = 'hf_abc'
  })

  it('keeps the result next to the field after the toast is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    )
    render(<ModelDefaultsCard />)
    fireEvent.click(screen.getByText('settings:general.verify'))
    expect(await screen.findByTestId('hf-token-status')).toHaveTextContent(
      'settings:general.hfToken.invalid'
    )
  })

  it('disables Verify for an empty token', () => {
    store.token = '  '
    render(<ModelDefaultsCard />)
    expect(screen.getByText('settings:general.verify').closest('button')).toBeDisabled()
    expect(screen.queryByTestId('hf-token-status')).toBeNull()
  })

  it('shows a valid hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ name: 'me' }) }))
    )
    render(<ModelDefaultsCard />)
    fireEvent.click(screen.getByText('settings:general.verify'))
    await waitFor(() =>
      expect(screen.getByTestId('hf-token-status')).toHaveTextContent(
        'settings:general.hfToken.valid'
      )
    )
  })
})
