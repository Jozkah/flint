/**
 * A custom OpenAI-compatible endpoint (LM Studio, mlx_lm.server, a LAN Ollama)
 * needs no API key, so the dialog must let it be created without one. An
 * Anthropic-compatible endpoint still requires a key.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// Opening the dialog probes loopback; keep this test offline.
vi.mock('@/lib/localProviderProbe', () => ({
  probeLocalProviders: async () => [],
}))

import { AddProviderDialog } from '../AddProviderDialog'

function open(onCreate = vi.fn()) {
  render(
    <AddProviderDialog onCreateProvider={onCreate}>
      <button>open</button>
    </AddProviderDialog>
  )
  fireEvent.click(screen.getByText('open'))
  fireEvent.change(screen.getByPlaceholderText('provider:enterNameForProvider'), {
    target: { value: 'LM Studio' },
  })
  fireEvent.change(screen.getByPlaceholderText('provider:baseUrlPlaceholder'), {
    target: { value: 'http://localhost:1234/v1' },
  })
  return onCreate
}

describe('AddProviderDialog API key', () => {
  it('creates an OpenAI-compatible provider without a key', () => {
    const onCreate = open()
    const create = screen.getByLabelText('common:create') as HTMLButtonElement
    expect(create.disabled).toBe(false)
    fireEvent.click(create)
    expect(onCreate).toHaveBeenCalledWith(
      'LM Studio',
      'http://localhost:1234/v1',
      '',
      'openai'
    )
  })

  it('still requires a key for an Anthropic-compatible provider', () => {
    open()
    fireEvent.click(screen.getByText('provider:apiTypeAnthropic'))
    const create = screen.getByLabelText('common:create') as HTMLButtonElement
    expect(create.disabled).toBe(true)
  })
})
