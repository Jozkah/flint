import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useFavoriteModel } from '../useFavoriteModel'
import { act } from '@testing-library/react'

// Mock zustand persist
vi.mock('zustand/middleware', () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: {
    favoriteModels: 'favorite-models',
  },
}))

vi.mock('@/lib/fileStorage', () => ({
  fileStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}))

const makeModel = (id: string): Model =>
  ({ id, name: id, engine: 'llamacpp' } as any)

describe('useFavoriteModel', () => {
  beforeEach(() => {
    act(() => {
      useFavoriteModel.setState({ favoriteModels: [] })
    })
  })

  it('should start with empty favorites', () => {
    const state = useFavoriteModel.getState()
    expect(state.favoriteModels).toEqual([])
  })

  it('should add a favorite', () => {
    const model = makeModel('model-1')

    act(() => {
      useFavoriteModel.getState().addFavorite(model)
    })

    expect(useFavoriteModel.getState().favoriteModels).toHaveLength(1)
    expect(useFavoriteModel.getState().favoriteModels[0].id).toBe('model-1')
  })

  it('should not add duplicate favorites', () => {
    const model = makeModel('model-1')

    act(() => {
      useFavoriteModel.getState().addFavorite(model)
      useFavoriteModel.getState().addFavorite(model)
    })

    expect(useFavoriteModel.getState().favoriteModels).toHaveLength(1)
  })

  it('should remove a favorite', () => {
    const model = makeModel('model-1')

    act(() => {
      useFavoriteModel.getState().addFavorite(model)
    })

    act(() => {
      useFavoriteModel.getState().removeFavorite('model-1')
    })

    expect(useFavoriteModel.getState().favoriteModels).toHaveLength(0)
  })

  it('should check isFavorite correctly', () => {
    const model = makeModel('model-1')

    act(() => {
      useFavoriteModel.getState().addFavorite(model)
    })

    expect(useFavoriteModel.getState().isFavorite('model-1')).toBe(true)
    expect(useFavoriteModel.getState().isFavorite('model-2')).toBe(false)
  })

  it('should toggle favorite on', () => {
    const model = makeModel('model-1')

    act(() => {
      useFavoriteModel.getState().toggleFavorite(model)
    })

    expect(useFavoriteModel.getState().isFavorite('model-1')).toBe(true)
  })

  it('should toggle favorite off', () => {
    const model = makeModel('model-1')

    act(() => {
      useFavoriteModel.getState().addFavorite(model)
    })

    act(() => {
      useFavoriteModel.getState().toggleFavorite(model)
    })

    expect(useFavoriteModel.getState().isFavorite('model-1')).toBe(false)
  })

  it('should handle multiple favorites', () => {
    act(() => {
      useFavoriteModel.getState().addFavorite(makeModel('a'))
      useFavoriteModel.getState().addFavorite(makeModel('b'))
      useFavoriteModel.getState().addFavorite(makeModel('c'))
    })

    expect(useFavoriteModel.getState().favoriteModels).toHaveLength(3)

    act(() => {
      useFavoriteModel.getState().removeFavorite('b')
    })

    expect(useFavoriteModel.getState().favoriteModels).toHaveLength(2)
    expect(useFavoriteModel.getState().isFavorite('b')).toBe(false)
  })
})

describe('useFavoriteModel per provider', () => {
  beforeEach(() => {
    act(() => {
      useFavoriteModel.setState({ favoriteModels: [] })
    })
  })

  it('stars a model under one provider only', () => {
    const model = makeModel('llama3')
    act(() => {
      useFavoriteModel.getState().toggleFavorite(model, 'ollama')
    })
    const { isFavorite } = useFavoriteModel.getState()
    expect(isFavorite('llama3', 'ollama')).toBe(true)
    expect(isFavorite('llama3', 'openrouter')).toBe(false)
  })

  it('keeps the same model starred under two providers independently', () => {
    const model = makeModel('llama3')
    act(() => {
      useFavoriteModel.getState().addFavorite(model, 'ollama')
      useFavoriteModel.getState().addFavorite(model, 'openrouter')
    })
    expect(useFavoriteModel.getState().favoriteModels).toHaveLength(2)

    act(() => {
      useFavoriteModel.getState().removeFavorite('llama3', 'ollama')
    })
    const { isFavorite } = useFavoriteModel.getState()
    expect(isFavorite('llama3', 'ollama')).toBe(false)
    expect(isFavorite('llama3', 'openrouter')).toBe(true)
  })

  it('gives a legacy entry to every provider that lists the model', () => {
    act(() => {
      useFavoriteModel.setState({
        favoriteModels: [makeModel('llama3'), makeModel('gone')],
      })
    })
    act(() => {
      useFavoriteModel.getState().assignLegacyProviders([
        { provider: 'ollama', models: [{ id: 'llama3' }] },
        { provider: 'openrouter', models: [{ id: 'llama3' }, { id: 'x' }] },
      ])
    })
    const favs = useFavoriteModel.getState().favoriteModels
    expect(
      favs.filter((f) => f.id === 'llama3').map((f) => f.provider).sort()
    ).toEqual(['ollama', 'openrouter'])
    // Listed by no provider: left as saved.
    expect(favs.find((f) => f.id === 'gone')?.provider).toBeUndefined()
  })
})
