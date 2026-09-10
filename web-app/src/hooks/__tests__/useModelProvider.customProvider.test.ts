/**
 * Does a user-added local provider survive the startup refresh?
 *
 * The reported defect is that Settings -> Providers shows only the twelve
 * disabled public templates and a user's own local endpoint is gone. Startup
 * calls `getProviders()` -- which returns engine providers plus the predefined
 * catalogue and never reads a user-added one -- and hands the result to
 * `setProviders`. Whether that loses the custom provider depends entirely on
 * the merge, so this pins the merge down rather than reasoning about it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { useModelProvider } from '../useModelProvider'

vi.mock('@/lib/fileStorage', () => ({
  fileStorage: {
    getItem: vi.fn(() => Promise.resolve(null)),
    setItem: vi.fn(() => Promise.resolve()),
    removeItem: vi.fn(() => Promise.resolve()),
  },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: vi.fn(() => ({ path: () => ({ sep: () => '/' }) })),
}))

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { modelProvider: 'jan-model-provider' },
}))

/** A user-added OpenAI-compatible endpoint on the local network. */
const customProvider = () =>
  ({
    provider: 'v100-test',
    active: true,
    persist: false,
    base_url: 'http://v100:8555/v1',
    api_key: '',
    settings: [],
    models: [
      {
        id: 'pxa-27b',
        model: 'pxa-27b',
        name: 'pxa-27b',
        capabilities: ['tools'],
        provider: 'v100-test',
        settings: {},
      },
    ],
  }) as never

/** What `getProviders()` returns on startup: engine + predefined catalogue. */
const startupRefresh = () =>
  [
    {
      provider: 'llamacpp',
      active: true,
      persist: true,
      base_url: '',
      settings: [],
      models: [],
    },
    {
      provider: 'openai',
      active: false,
      persist: false,
      base_url: 'https://api.openai.com/v1',
      settings: [],
      models: [],
    },
  ] as never[]

const reset = () =>
  act(() => {
    useModelProvider.setState({
      providers: [],
      selectedProvider: 'llamacpp',
      selectedModel: null,
      deletedModels: [],
    })
  })

describe('a user-added local provider', () => {
  beforeEach(reset)

  it('is kept when the startup refresh does not mention it', () => {
    act(() => {
      useModelProvider.getState().addProvider(customProvider())
    })
    expect(
      useModelProvider.getState().providers.map((p) => p.provider)
    ).toContain('v100-test')

    // Startup: the service returns engine + catalogue only.
    act(() => {
      useModelProvider.getState().setProviders(startupRefresh())
    })

    const names = useModelProvider.getState().providers.map((p) => p.provider)
    expect(names).toContain('v100-test')
  })

  it('keeps its endpoint exactly as entered', () => {
    act(() => {
      useModelProvider.getState().addProvider(customProvider())
      useModelProvider.getState().setProviders(startupRefresh())
    })
    const p = useModelProvider
      .getState()
      .providers.find((x) => x.provider === 'v100-test')
    // Not rewritten to an IP, not normalised, not stripped of its path.
    expect(p?.base_url).toBe('http://v100:8555/v1')
  })

  it('keeps its discovered models through the refresh', () => {
    act(() => {
      useModelProvider.getState().addProvider(customProvider())
      useModelProvider.getState().setProviders(startupRefresh())
    })
    const p = useModelProvider
      .getState()
      .providers.find((x) => x.provider === 'v100-test')
    expect(p?.models.map((m) => m.id)).toContain('pxa-27b')
  })

  it('stays active rather than being disabled by the refresh', () => {
    act(() => {
      useModelProvider.getState().addProvider(customProvider())
      useModelProvider.getState().setProviders(startupRefresh())
    })
    const p = useModelProvider
      .getState()
      .providers.find((x) => x.provider === 'v100-test')
    expect(p?.active).toBe(true)
  })

  it('survives a second refresh, which is what a restart looks like', () => {
    act(() => {
      useModelProvider.getState().addProvider(customProvider())
      useModelProvider.getState().setProviders(startupRefresh())
      useModelProvider.getState().setProviders(startupRefresh())
    })
    expect(
      useModelProvider.getState().providers.map((p) => p.provider)
    ).toContain('v100-test')
  })
})
