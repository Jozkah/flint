import { describe, it, expect, vi, beforeEach } from 'vitest'

const forgetAllServerLimits = vi.fn()
const forgetOrigin = vi.fn()

vi.mock('@/lib/contextLimitRecovery', () => ({
  forgetAllServerLimits: () => forgetAllServerLimits(),
}))
vi.mock('@/hooks/useProviderReachability', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useProviderReachability')>()),
  useProviderReachability: {
    getState: () => ({ forgetOrigin: (o: string) => forgetOrigin(o) }),
  },
}))
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

import { useModelProvider } from '../useModelProvider'

const base = {
  provider: 'acme',
  active: true,
  base_url: 'https://a.example.com/v1',
  api_key: 'k1',
  api_key_fallbacks: ['f1', 'f2'],
  settings: [],
  models: [],
} as unknown as ModelProvider

describe('updateProvider only resets learned state on a real change', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useModelProvider.setState({ providers: [{ ...base }] })
  })

  const update = (data: Partial<ModelProvider>) =>
    useModelProvider.getState().updateProvider('acme', data)

  it('a whole-provider spread with nothing changed does not reset', () => {
    update({ ...useModelProvider.getState().providers[0] })
    expect(forgetAllServerLimits).not.toHaveBeenCalled()
    expect(forgetOrigin).not.toHaveBeenCalled()
  })

  it('a models-only update never resets', () => {
    update({ models: [] })
    expect(forgetAllServerLimits).not.toHaveBeenCalled()
  })

  it('a changed base_url resets and forgets old and new origin', () => {
    update({ base_url: 'https://b.example.com/v1' })
    expect(forgetAllServerLimits).toHaveBeenCalledTimes(1)
    expect(forgetOrigin).toHaveBeenCalledWith('https://a.example.com')
    expect(forgetOrigin).toHaveBeenCalledWith('https://b.example.com')
  })

  it('a changed api_key resets', () => {
    update({ api_key: 'k2' })
    expect(forgetAllServerLimits).toHaveBeenCalledTimes(1)
  })

  it('reordered fallbacks count as a change', () => {
    update({ api_key_fallbacks: ['f2', 'f1'] })
    expect(forgetAllServerLimits).toHaveBeenCalledTimes(1)
  })
})
