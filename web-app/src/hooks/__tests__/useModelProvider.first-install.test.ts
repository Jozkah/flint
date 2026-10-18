import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useModelProvider } from '../useModelProvider'

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: vi.fn(() => ({ path: () => ({ sep: () => '/' }) })),
}))
vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { modelProvider: 'jan-model-provider' },
}))

const provider = (name: string, extra: Record<string, unknown> = {}) =>
  ({ provider: name, active: false, models: [], settings: [], base_url: '', ...extra }) as never

describe('useModelProvider - first install', () => {
  beforeEach(() => {
    useModelProvider.setState({ providers: [] })
  })

  it('starts with the built-in cloud providers off and the local engine on', () => {
    const { result } = renderHook(() => useModelProvider())
    act(() => {
      result.current.setProviders([provider('openai'), provider('anthropic'), provider('llamacpp')])
    })
    const active = (name: string) => result.current.providers.find((p) => p.provider === name)?.active
    expect(active('openai')).toBe(false)
    expect(active('anthropic')).toBe(false)
    expect(active('llamacpp')).toBe(true)
  })

  it('keeps what the user already chose for a provider it knows', () => {
    const { result } = renderHook(() => useModelProvider())
    act(() => {
      result.current.setProviders([provider('openai')])
    })
    act(() => {
      result.current.updateProvider('openai', { active: true })
    })
    act(() => {
      result.current.setProviders([provider('openai')])
    })
    expect(result.current.providers.find((p) => p.provider === 'openai')?.active).toBe(true)
  })
})
