import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const navigate = vi.fn()
const createThread = vi.fn()
const providerState = {
  selectedModel: undefined as { id: string } | undefined,
  selectedProvider: 'llamacpp',
  getProviderByName: vi.fn(() => ({ models: [] as Array<{ id: string }> })),
}

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: { getState: () => providerState },
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ createThread }) },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { NewTemporaryChatButton } from '../NewTemporaryChatButton'
import { useDraftSampling } from '@/hooks/useDraftSampling'

describe('NewTemporaryChatButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerState.selectedModel = undefined
    providerState.selectedProvider = 'llamacpp'
    providerState.getProviderByName = vi.fn(() => ({ models: [] }))
  })

  it('drops a composer sampling draft so it cannot leak into a later chat', async () => {
    providerState.selectedModel = { id: 'qwen3-8b' }
    useDraftSampling.getState().set('a1', { temperature: 0.1 })
    render(<NewTemporaryChatButton />)
    await userEvent.click(screen.getByRole('button'))
    expect(useDraftSampling.getState().byAssistant).toEqual({})
  })

  it('starts a temporary chat with the selected model', async () => {
    providerState.selectedModel = { id: 'qwen3-8b' }

    render(<NewTemporaryChatButton />)
    await userEvent.click(screen.getByRole('button'))

    expect(createThread).toHaveBeenCalledWith(
      { id: 'qwen3-8b', provider: 'llamacpp' },
      undefined,
      undefined,
      undefined,
      true
    )
    expect(navigate).toHaveBeenCalled()
  })

  it('falls back to the local provider own first model', async () => {
    providerState.getProviderByName = vi.fn(() => ({
      models: [{ id: 'gemma-3-4b' }],
    }))

    render(<NewTemporaryChatButton />)
    await userEvent.click(screen.getByRole('button'))

    expect(createThread).toHaveBeenCalledWith(
      { id: 'gemma-3-4b', provider: 'llamacpp' },
      undefined,
      undefined,
      undefined,
      true
    )
  })

  // janhq/jan#8007: the fallback used to hand `llamacpp` a cloud model id.
  it('refuses to open a thread when a local provider has no model', async () => {
    render(<NewTemporaryChatButton />)
    await userEvent.click(screen.getByRole('button'))

    expect(createThread).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
