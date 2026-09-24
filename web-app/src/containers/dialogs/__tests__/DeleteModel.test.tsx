import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  deleteModel: vi.fn(),
  getProviders: vi.fn(),
  deleteModelCache: vi.fn(),
  setProviders: vi.fn(),
  removeFavorite: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({
    setProviders: mocks.setProviders,
    deleteModel: mocks.deleteModelCache,
  }),
}))
vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: () => ({ removeFavorite: mocks.removeFavorite }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({ deleteModel: mocks.deleteModel }),
    providers: () => ({ getProviders: mocks.getProviders }),
  }),
}))

import { DialogDeleteModel } from '@/containers/dialogs/DeleteModel'

const provider = {
  provider: 'llamacpp',
  active: true,
  settings: [],
  models: [{ id: 'm1', capabilities: [] }],
} as unknown as ModelProvider

async function confirmDelete() {
  render(<DialogDeleteModel provider={provider} modelId="m1" />)
  fireEvent.click(
    screen.getByRole('button', { name: 'providers:deleteModel.delete' })
  )
  const buttons = await screen.findAllByRole('button', {
    name: 'providers:deleteModel.delete',
  })
  fireEvent.click(buttons[buttons.length - 1])
}

describe('DialogDeleteModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  // Regression for #167: a failed backend delete must not remove the model
  // from local state, and must be reported.
  it('keeps local state and reports the error when the delete fails', async () => {
    mocks.deleteModel.mockRejectedValue(new Error('disk is read-only'))
    await confirmDelete()

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(mocks.deleteModelCache).not.toHaveBeenCalled()
    expect(mocks.removeFavorite).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('removes the model locally only after the backend delete succeeds', async () => {
    mocks.deleteModel.mockResolvedValue(undefined)
    mocks.getProviders.mockResolvedValue([
      { ...provider, models: [{ id: 'm1' }, { id: 'm2' }] },
    ])
    await confirmDelete()

    await waitFor(() => expect(mocks.setProviders).toHaveBeenCalled())
    expect(mocks.deleteModel).toHaveBeenCalledWith('m1', 'llamacpp')
    expect(mocks.deleteModelCache).toHaveBeenCalledWith('m1')
    expect(mocks.removeFavorite).toHaveBeenCalledWith('m1')
    expect(mocks.toastSuccess).toHaveBeenCalled()
    expect(mocks.setProviders.mock.calls[0][0][0].models).toEqual([{ id: 'm2' }])
  })
})
