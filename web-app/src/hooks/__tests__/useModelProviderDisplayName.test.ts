import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useModelProvider } from '../useModelProvider'
import { getModelDisplayName } from '@/lib/utils'

/**
 * A rename has to outlive the list it was made against.
 *
 * Provider model lists are refetched — from an engine's `list()` for local
 * providers, from the API for remote ones — and merged over what is already
 * stored. A custom name lives only in the stored copy, so the merge is the
 * one place it can silently disappear.
 */

const store = () => useModelProvider.getState()

const provider = (models: Partial<Model>[]) =>
  ({
    provider: 'openai',
    active: true,
    models,
    settings: [],
  }) as unknown as ModelProvider

/** The model as the store now holds it. */
const stored = (id: string): Model | undefined =>
  store()
    .providers.find((p) => p.provider === 'openai')
    ?.models.find((m) => m.id === id)

describe('a renamed model', () => {
  beforeEach(() => {
    useModelProvider.setState({
      providers: [],
      selectedProvider: 'llamacpp',
      selectedModel: null,
      deletedModels: [],
    })
  })

  it('keeps its name when the provider’s models are fetched again', () => {
    store().setProviders([provider([{ id: 'gpt-5' }])])
    store().updateProvider('openai', {
      models: [{ id: 'gpt-5', displayName: 'Daily driver' } as Model],
    })

    // The same list arrives again, as it would after a refresh: the fetch
    // knows nothing about the rename.
    store().setProviders([provider([{ id: 'gpt-5' }])])

    expect(stored('gpt-5')?.displayName).toBe('Daily driver')
    expect(getModelDisplayName(stored('gpt-5') as Model)).toBe('Daily driver')
  })

  it('keeps its identifier, which is what requests carry', () => {
    store().setProviders([provider([{ id: 'gpt-5' }])])
    store().updateProvider('openai', {
      models: [{ id: 'gpt-5', displayName: 'Daily driver' } as Model],
    })
    store().setProviders([provider([{ id: 'gpt-5' }])])

    expect(stored('gpt-5')?.id).toBe('gpt-5')
  })

  it('does not lend its name to the other models beside it', () => {
    store().setProviders([provider([{ id: 'gpt-5' }, { id: 'o3' }])])
    store().updateProvider('openai', {
      models: [
        { id: 'gpt-5', displayName: 'Daily driver' } as Model,
        { id: 'o3' } as Model,
      ],
    })
    store().setProviders([provider([{ id: 'gpt-5' }, { id: 'o3' }])])

    expect(stored('o3')?.displayName).toBeUndefined()
    expect(getModelDisplayName(stored('o3') as Model)).toBe('o3')
  })

  it('takes the incoming name for a model it never renamed', () => {
    // A provider that ships its own display name still gets to set one.
    store().setProviders([
      provider([{ id: 'gpt-5', displayName: 'GPT-5' } as Model]),
    ])
    expect(stored('gpt-5')?.displayName).toBe('GPT-5')
  })

  it('prefers the user’s name over the one the provider ships', () => {
    store().setProviders([provider([{ id: 'gpt-5' }])])
    store().updateProvider('openai', {
      models: [{ id: 'gpt-5', displayName: 'Daily driver' } as Model],
    })
    store().setProviders([
      provider([{ id: 'gpt-5', displayName: 'GPT-5' } as Model]),
    ])

    expect(stored('gpt-5')?.displayName).toBe('Daily driver')
  })
})
