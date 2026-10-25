import { describe, it, expect, vi } from 'vitest'

vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))
vi.mock('@/lib/backendStorage', () => ({
  backendStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

import {
  buildSearchChain,
  legacyChain,
  chainEntryOptions,
  chainEntryId,
} from '@/hooks/useWebSearchConfig'

describe('buildSearchChain', () => {
  it('keeps the user order: keyless first, keyed last', () => {
    const chain = buildSearchChain({
      searchChain: [
        { provider: 'exa', useKey: false, enabled: true },
        { provider: 'duckduckgo', useKey: false, enabled: true },
        { provider: 'exa', useKey: true, enabled: true },
      ],
      apiKeys: { exa: 'k' },
      endpoints: {},
    })
    expect(chain).toEqual([
      { provider: 'exa', endpoint: undefined },
      { provider: 'duckduckgo', endpoint: undefined },
      { provider: 'exa', apiKey: 'k', endpoint: undefined },
    ])
  })

  it('drops disabled entries and keyed entries with no key', () => {
    const chain = buildSearchChain({
      searchChain: [
        { provider: 'exa', useKey: true, enabled: true },
        { provider: 'brave', useKey: true, enabled: true },
        { provider: 'duckduckgo', useKey: false, enabled: false },
        { provider: 'searxng', useKey: false, enabled: true },
      ],
      apiKeys: {},
      endpoints: {},
    })
    expect(chain).toEqual([])
  })

  it('never sends a key for a keyless entry', () => {
    const [entry] = buildSearchChain({
      searchChain: [{ provider: 'exa', useKey: false, enabled: true }],
      apiKeys: { exa: 'k' },
      endpoints: {},
    })
    expect(entry.apiKey).toBeUndefined()
  })
})

describe('legacyChain', () => {
  it('keeps keyless Exa and DuckDuckGo backing each other up', () => {
    expect(legacyChain('duckduckgo').map(chainEntryId)).toEqual([
      'duckduckgo:free',
      'exa:free',
    ])
    expect(legacyChain('exa').map(chainEntryId)).toEqual([
      'exa:key',
      'exa:free',
      'duckduckgo:free',
    ])
  })
})

it('offers both modes only for providers that work either way', () => {
  const ids = chainEntryOptions().map(chainEntryId)
  expect(ids).toContain('exa:free')
  expect(ids).toContain('exa:key')
  expect(ids).toContain('brave:key')
  expect(ids).not.toContain('brave:free')
  expect(ids).toContain('duckduckgo:free')
})
