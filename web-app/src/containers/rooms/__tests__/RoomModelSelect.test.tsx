import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
  it('names the provider on a model several providers offer', () => {
    render(<RoomModelSelect id="m" value={null} onChange={() => {}} />)
    const labels = screen.getAllByRole('option').map((o) => o.textContent)
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

  it('groups the options by provider', () => {
    const { container } = render(<RoomModelSelect id="m" value={null} onChange={() => {}} />)
    const groups = [...container.querySelectorAll('optgroup')].map((g) => g.label)
    // Groups are labelled by the provider title, which follows renames.
    expect(groups).toEqual(['OpenAI', 'OpenRouter', 'Groq'])
  })
})
