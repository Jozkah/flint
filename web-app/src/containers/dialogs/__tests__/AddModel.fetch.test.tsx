/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { fetchModelsFromProvider, hub } = vi.hoisted(() => {
  const fetchModelsFromProvider = vi.fn().mockResolvedValue(['m1'])
  return { fetchModelsFromProvider, hub: { providers: () => ({ fetchModelsFromProvider }) } }
})
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => hub }))
vi.mock('@/hooks/useModelProvider', () => {
  const state = { updateProvider: () => {} }
  return { useModelProvider: () => state }
})
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { DialogAddModel } from '../AddModel'
import { canListProviderModels } from '@/lib/provider-api-keys'

const provider = (over: Partial<any> = {}): any => ({
  provider: 'cerebras',
  base_url: 'https://api.cerebras.ai/v1',
  api_key: '',
  models: [],
  settings: [],
  active: true,
  ...over,
})

describe('provider model list fetching', () => {
  beforeEach(() => fetchModelsFromProvider.mockClear())

  it('does not ask a public provider without a key', () => {
    expect(canListProviderModels(provider())).toBe(false)
    expect(canListProviderModels(provider({ api_key: 'sk-test' }))).toBe(true)
    expect(canListProviderModels(provider({ base_url: 'http://127.0.0.1:8080/v1' }))).toBe(true)
  })

  it('fetches nothing while the page is open and the dialog is closed', async () => {
    const p = provider({ api_key: 'sk-test' })
    render(<DialogAddModel provider={p} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchModelsFromProvider).not.toHaveBeenCalled()
  })

  it('fetches once when the dialog opens, if a key is stored', async () => {
    const p = provider({ api_key: 'sk-test', provider: 'p-once' })
    render(<DialogAddModel provider={p} />)
    fireEvent.click(screen.getAllByRole('button')[0])
    await waitFor(() => expect(fetchModelsFromProvider).toHaveBeenCalledTimes(1))
  })

  it('never fetches for a keyless public provider, even when opened', async () => {
    const p = provider({ provider: 'p-nokey' })
    render(<DialogAddModel provider={p} />)
    fireEvent.click(screen.getAllByRole('button')[0])
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchModelsFromProvider).not.toHaveBeenCalled()
  })
})
