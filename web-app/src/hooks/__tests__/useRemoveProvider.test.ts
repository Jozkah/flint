/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const h = vi.hoisted(() => ({
  deleteProviderKeys: vi.fn().mockResolvedValue(undefined),
  deleteSecretHeaderValues: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@janhq/core', () => ({
  EngineManager: { instance: () => ({ get: () => undefined }) },
}))
vi.mock('@/hooks/useServiceHub', () => {
  const hub = { providers: () => ({ deleteProviderKeys: h.deleteProviderKeys }) }
  return { useServiceHub: () => hub }
})
vi.mock('@/lib/providerHeaderSecrets', () => ({
  deleteSecretHeaderValues: h.deleteSecretHeaderValues,
}))

import { isRemovableProvider, useRemoveProvider } from '../useRemoveProvider'
import { useModelProvider } from '../useModelProvider'
import { useFavoriteModel } from '../useFavoriteModel'

const custom: any = {
  provider: 'Qwen 3.8 500k (8081)',
  active: true,
  settings: [],
  models: [{ id: 'qwen-local' }, { id: 'qwen-other' }],
}
const openai: any = {
  provider: 'openai',
  active: true,
  settings: [],
  models: [{ id: 'gpt-5' }],
}

describe('isRemovableProvider', () => {
  it('lets the user remove providers they added, not built-in ones', () => {
    expect(isRemovableProvider('Qwen 3.8 500k (8081)')).toBe(true)
    expect(isRemovableProvider('8556')).toBe(true)
    expect(isRemovableProvider('openai')).toBe(false)
    expect(isRemovableProvider('gemini')).toBe(false)
    expect(isRemovableProvider('llamacpp')).toBe(false)
    expect(isRemovableProvider('mlx')).toBe(false)
  })
})

describe('useRemoveProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useModelProvider.setState({
      providers: [custom, openai],
      selectedProvider: custom.provider,
      selectedModel: custom.models[0],
    } as any)
    useFavoriteModel.setState({
      favoriteModels: [{ id: 'qwen-local' } as any, { id: 'gpt-5' } as any],
    } as any)
  })

  it('removes the provider, its secrets, favourites and a selection pointing at it', async () => {
    const { result } = renderHook(() => useRemoveProvider())
    await act(() => result.current(custom))
    const state = useModelProvider.getState()
    expect(state.providers.map((p) => p.provider)).toEqual(['openai'])
    expect(state.selectedProvider).toBe('llamacpp')
    expect(state.selectedModel).toBeNull()
    expect(h.deleteProviderKeys).toHaveBeenCalledWith(custom.provider)
    expect(h.deleteSecretHeaderValues).toHaveBeenCalledWith(custom.provider)
    expect(useFavoriteModel.getState().favoriteModels.map((m) => m.id)).toEqual([
      'gpt-5',
    ])
  })

  it('keeps a selection that points at another provider', async () => {
    useModelProvider.setState({
      selectedProvider: 'openai',
      selectedModel: openai.models[0],
    } as any)
    const { result } = renderHook(() => useRemoveProvider())
    await act(() => result.current(custom))
    expect(useModelProvider.getState().selectedProvider).toBe('openai')
  })
})
