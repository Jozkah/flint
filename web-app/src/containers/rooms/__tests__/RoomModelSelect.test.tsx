import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { RoomModelSelect } from '../RoomModelSelect'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const u = await import('./roomsTestUtils')
  return { useTranslation: () => ({ t: u.t }) }
})

// One model name served by three providers, as in the live report where
// "qwen3.8-27b" was listed three times with nothing to tell them apart.
const provider = (name: string, models: { id: string; name: string }[]) => ({
  provider: name,
  active: true,
  api_key: 'test-key',
  settings: [],
  models: models.map((m) => ({ ...m, capabilities: ['tools'] })),
})
const providers = [
  provider('openai', [{ id: 'qwen3.8-27b', name: 'qwen3.8-27b' }, { id: 'solo', name: 'Solo Model' }]),
  provider('openrouter', [{ id: 'qwen3.8-27b', name: 'qwen3.8-27b' }]),
  provider('groq', [{ id: 'qwen3.8-27b', name: 'qwen3.8-27b' }]),
]

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: { providers: unknown }) => unknown) => sel({ providers }),
}))

describe('RoomModelSelect', () => {
  it('names the provider on a model several providers offer', async () => {
    render(<RoomModelSelect id="m" value={null} onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    const labels = (await screen.findAllByRole('menuitemradio')).map(
      (o) => o.querySelector('.truncate')?.textContent
    )
    expect(labels).toEqual(
      expect.arrayContaining([
        'qwen3.8-27b — openai',
        'qwen3.8-27b — openrouter',
        'qwen3.8-27b — groq',
        // A name only one provider offers stays as it is.
        'Solo Model',
      ])
    )
    expect(labels.filter((l) => l === 'qwen3.8-27b')).toHaveLength(0)
  })

  it('groups the options by provider', async () => {
    render(<RoomModelSelect id="m" value={null} onChange={() => {}} />)
    await userEvent.click(screen.getByRole('button'))
    // Groups are labelled by the provider title, which follows renames.
    await screen.findAllByRole('menuitemradio')
    const headings = [...document.querySelectorAll('[data-slot="dropdown-menu-label"]')].map(
      (h) => h.textContent
    )
    expect(headings).toEqual(['OpenAI', 'OpenRouter', 'Groq'])
  })

  it('reports the model chosen from the list', async () => {
    const onChange = vi.fn()
    render(<RoomModelSelect id="m" value={null} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button'))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /^Solo Model/ }))
    expect(onChange).toHaveBeenCalledWith({ provider: 'openai', id: 'solo' })
  })
})
