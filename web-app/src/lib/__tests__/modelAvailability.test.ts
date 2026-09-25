import { describe, expect, it, beforeEach } from 'vitest'
import {
  isOffline,
  modelAvailability,
  OFFLINE_ROW_CLASS,
  providerIsUnreachable,
} from '@/lib/modelAvailability'
import {
  isLoopback,
  originOf,
  useProviderReachability,
} from '@/hooks/useProviderReachability'

/**
 * The rule that matters most here: an installed local model that simply is
 * not loaded is ready, not offline. Getting that wrong would paint the most
 * ordinary state in the app red.
 */

const base = {
  isLocal: false,
  providerActive: true,
  hasApiKey: true,
  baseUrl: 'https://api.example.com/v1',
  unreachableOrigins: {} as Record<string, unknown>,
}

const down = { 'https://api.example.com': { reason: 'x', at: 0 } }

describe('local models', () => {
  it('are ready when on disk but not loaded', () => {
    expect(
      modelAvailability({ ...base, isLocal: true, hasApiKey: false })
    ).toBe('local-ready')
  })

  it('are never offline, even while an endpoint is unreachable', () => {
    // A local engine's health is the engine's to report.
    const state = modelAvailability({
      ...base,
      isLocal: true,
      hasApiKey: false,
      baseUrl: 'http://127.0.0.1:1337',
      unreachableOrigins: { 'http://127.0.0.1:1337': { reason: 'x', at: 0 } },
    })
    expect(isOffline(state)).toBe(false)
  })

  it('report loading and loaded separately', () => {
    expect(
      modelAvailability({ ...base, isLocal: true, modelLoading: true })
    ).toBe('loading')
    expect(
      modelAvailability({ ...base, isLocal: true, modelLoaded: true })
    ).toBe('loaded')
  })
})

describe('remote models', () => {
  it('are ready with a key and no failure on record', () => {
    expect(modelAvailability(base)).toBe('remote-ready')
  })

  it('are offline once a real request to them has failed', () => {
    expect(
      modelAvailability({ ...base, unreachableOrigins: down })
    ).toBe('offline')
  })

  it('are misconfigured rather than offline without a key', () => {
    expect(modelAvailability({ ...base, hasApiKey: false })).toBe(
      'misconfigured'
    )
  })

  it('are disabled rather than offline when the provider is off', () => {
    expect(
      modelAvailability({
        ...base,
        providerActive: false,
        unreachableOrigins: down,
      })
    ).toBe('disabled')
  })

  it('report work in progress ahead of the resting state', () => {
    expect(
      modelAvailability({ ...base, modelDownloading: true, unreachableOrigins: down })
    ).toBe('downloading')
    expect(
      modelAvailability({ ...base, modelLoading: true, unreachableOrigins: down })
    ).toBe('loading')
  })

  it('are unaffected by a different endpoint being down', () => {
    expect(
      modelAvailability({
        ...base,
        unreachableOrigins: { 'https://elsewhere.test': { reason: 'x', at: 0 } },
      })
    ).toBe('remote-ready')
  })
})

describe('the treatment', () => {
  it('is a wash and a hairline, never a solid fill', () => {
    expect(OFFLINE_ROW_CLASS).toMatch(/destructive\/\[0\.0[0-9]\]/)
    expect(OFFLINE_ROW_CLASS).toMatch(/dark:/)
    expect(OFFLINE_ROW_CLASS).not.toMatch(/bg-destructive\s|bg-destructive$/)
  })

  it('marks only the offline state', () => {
    expect(isOffline('offline')).toBe(true)
    for (const other of ['local-ready', 'loading', 'misconfigured', 'disabled'] as const) {
      expect(isOffline(other)).toBe(false)
    }
  })
})

describe('the reachability record', () => {
  beforeEach(() => useProviderReachability.setState({ unreachable: {} }))

  it('remembers a failure and forgets it on success', () => {
    const s = () => useProviderReachability.getState()
    s().markUnreachable('https://api.example.com', 'timed out', 1)
    expect(s().isUnreachable('https://api.example.com')).toBe(true)

    s().markReachable('https://api.example.com')
    expect(s().isUnreachable('https://api.example.com')).toBe(false)
  })

  it('ignores loopback, which is the local engine', () => {
    const s = () => useProviderReachability.getState()
    s().markUnreachable('http://127.0.0.1:1337', 'refused')
    expect(s().unreachable).toEqual({})
  })

  it('recognises the loopback forms', () => {
    expect(isLoopback('http://localhost:3000')).toBe(true)
    expect(isLoopback('http://127.0.0.1:1337')).toBe(true)
    expect(isLoopback('https://api.example.com')).toBe(false)
  })

  it('reads an origin off a URL and shrugs at nonsense', () => {
    expect(originOf('https://api.example.com/v1/chat')).toBe(
      'https://api.example.com'
    )
    expect(originOf('not a url')).toBeNull()
    expect(originOf(undefined)).toBeNull()
  })

  it('forgets an origin when the provider is reconfigured', () => {
    const s = () => useProviderReachability.getState()
    s().markUnreachable('https://api.example.com', 'timed out')
    s().forgetOrigin('https://api.example.com')
    expect(s().isUnreachable('https://api.example.com')).toBe(false)
  })

  it('keeps nothing across a restart, having no persistence at all', () => {
    // A stale badge accuses a provider that may be perfectly fine.
    expect('persist' in useProviderReachability).toBe(false)
  })
})

describe('providerIsUnreachable', () => {
  it('flags a remote origin with a failure on record', () => {
    const down = { 'https://api.example.com': { reason: 'x', at: 1 } }
    expect(providerIsUnreachable({ base_url: 'https://api.example.com/v1' }, down)).toBe(true)
    expect(providerIsUnreachable({ base_url: 'https://other.example.com/v1' }, down)).toBe(false)
  })
  it('never flags loopback or a provider without a URL', () => {
    const down = { 'http://localhost:1337': { reason: 'x', at: 1 } }
    expect(providerIsUnreachable({ base_url: 'http://localhost:1337/v1' }, down)).toBe(false)
    expect(providerIsUnreachable({}, down)).toBe(false)
  })
  it('mutes the row as well as tinting it', () => {
    expect(OFFLINE_ROW_CLASS).toContain('opacity-70')
  })
})
