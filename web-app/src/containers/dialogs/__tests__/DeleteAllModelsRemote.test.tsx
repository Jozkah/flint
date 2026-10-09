import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  deleteModel: vi.fn(),
  getProviders: vi.fn(),
  deleteModelCache: vi.fn(),
  setProviders: vi.fn(),
  removeFavorite: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({
    setProviders: mocks.setProviders,
    deleteModel: mocks.deleteModelCache,
  }),
}))
vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: () => ({ removeFavorite: mocks.removeFavorite }),
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: () => [[]],
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({ deleteModel: mocks.deleteModel }),
    providers: () => ({ getProviders: mocks.getProviders }),
  }),
}))

import { DialogDeleteAllModels } from '@/containers/dialogs/DeleteAllModels'

const provider = {
  provider: 'openrouter',
  active: true,
  settings: [],
  models: [
    { id: 'a', capabilities: [] },
    { id: 'b', capabilities: [] },
  ],
} as unknown as ModelProvider

describe('DialogDeleteAllModels remote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getProviders.mockResolvedValue([provider])
  })

  it('clears every model after confirmation', async () => {
    render(<DialogDeleteAllModels provider={provider} remote />)
    fireEvent.click(
      screen.getByRole('button', { name: 'providers:deleteAllModels.clearButton' })
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'providers:deleteAllModels.confirm',
      })
    )
    await waitFor(() => expect(mocks.deleteModel).toHaveBeenCalledTimes(2))
    expect(mocks.deleteModelCache).toHaveBeenCalledWith('a')
    expect(mocks.deleteModelCache).toHaveBeenCalledWith('b')
  })
})
