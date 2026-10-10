/**
 * Opening the dialog probes loopback once and offers what it found; closing
 * or never opening makes no request. Choosing a suggestion only prefills the
 * form -- nothing is created until the user presses Create.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ probe: vi.fn() }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { name?: string }) => (o?.name ? `${k}:${o.name}` : k),
  }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (select: (s: { providers: unknown[] }) => unknown) =>
    select({ providers: [{ provider: 'ollama', base_url: 'http://localhost:11434/v1' }] }),
}))
vi.mock('@/lib/providerFetch', () => ({
  runtimeProviderFetch: () => vi.fn(),
}))
vi.mock('@/lib/localProviderProbe', () => ({
  probeLocalProviders: h.probe,
}))

import { AddProviderDialog } from '../AddProviderDialog'

function mount(onCreate = vi.fn()) {
  render(
    <AddProviderDialog onCreateProvider={onCreate}>
      <button>open</button>
    </AddProviderDialog>
  )
  return onCreate
}

describe('AddProviderDialog local detection', () => {
  beforeEach(() => h.probe.mockReset())

  it('makes no request until the dialog is opened', () => {
    h.probe.mockResolvedValue([])
    mount()
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('probes on open, skipping configured providers, and prefills on choice', async () => {
    h.probe.mockResolvedValue([
      { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
    ])
    const onCreate = mount()
    fireEvent.click(screen.getByText('open'))
    await waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1))
    expect(h.probe.mock.calls[0][1]).toEqual(['http://localhost:11434/v1'])

    fireEvent.click(await screen.findByText('provider:useDetected:LM Studio'))
    expect(onCreate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('common:create'))
    expect(onCreate).toHaveBeenCalledWith(
      'LM Studio',
      'http://localhost:1234/v1',
      '',
      'openai'
    )
  })

  it('shows nothing when nothing is found', async () => {
    h.probe.mockResolvedValue([])
    mount()
    fireEvent.click(screen.getByText('open'))
    await waitFor(() => expect(h.probe).toHaveBeenCalled())
    expect(screen.queryByTestId('detected-local-providers')).toBeNull()
  })
})
