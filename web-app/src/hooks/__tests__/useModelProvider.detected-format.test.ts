import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/contextLimitRecovery', () => ({ forgetAllServerLimits: vi.fn() }))
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

const provider = () =>
  ({
    provider: 'acme',
    active: true,
    base_url: 'https://a.example.com/v1',
    settings: [],
    models: [{ id: 'm', apiFormat: 'chat', detectedApiFormat: 'responses' }],
  }) as unknown as ModelProvider

const model = () => useModelProvider.getState().providers[0]!.models[0]!

describe('the detected API format follows the endpoint', () => {
  beforeEach(() => useModelProvider.setState({ providers: [provider()] }))

  it('survives an update that keeps the Base URL', () => {
    useModelProvider.getState().updateProvider('acme', { ...provider() })
    expect(model().detectedApiFormat).toBe('responses')
  })

  it('is forgotten when the Base URL changes; the user choice stays', () => {
    useModelProvider
      .getState()
      .updateProvider('acme', { base_url: 'https://b.example.com/v1' })
    expect(model().detectedApiFormat).toBeUndefined()
    expect(model().apiFormat).toBe('chat')
  })
})
