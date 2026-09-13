import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { endpointDiagnostics } = vi.hoisted(() => ({ endpointDiagnostics: vi.fn() }))
vi.mock('@/lib/providerFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providerFetch')>()),
  endpointDiagnostics,
  refreshEndpoint: vi.fn(),
}))

import {
  RECHECK_MS,
  useEndpointLocations,
  useProviderLocations,
} from '../useEndpointLocations'

const tailnet = {
  host: 'llm-host',
  port: 8555,
  local_name: false,
  candidates: [{ address: '100.118.119.72', class: 'tailscale', eligible: true }],
  selected: '100.118.119.72',
  suppressed_public: false,
  responded: null,
}

const providers = [{ provider: 'llm-host-lane', base_url: 'http://llm-host:8555/v1' }]

// A single-label endpoint is settled by the resolver, which only knows it once
// something has connected. The sidebar asked once, before that, got `null`,
// and kept `null` as the answer: the endpoint sat in neither LOCAL nor REMOTE
// for the session. Found by the real-provider lane against llm-host:8555.
describe('useProviderLocations', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    endpointDiagnostics.mockReset()
    useEndpointLocations.setState({ byEndpoint: {}, pending: {} })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks again until the resolver has an answer, then files the endpoint as local', async () => {
    endpointDiagnostics.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useProviderLocations(providers, () => false))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current(providers[0])).toBe('checking')

    // The chat request connects; the next check finds the resolver's answer.
    endpointDiagnostics.mockResolvedValue(tailnet)
    await act(async () => {
      vi.advanceTimersByTime(RECHECK_MS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current(providers[0])).toBe('local')

    // Settled endpoints are not asked about again.
    const calls = endpointDiagnostics.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(RECHECK_MS * 3)
      await Promise.resolve()
    })
    expect(endpointDiagnostics.mock.calls.length).toBe(calls)
  })

  it('never asks about an endpoint the URL already settles', async () => {
    renderHook(() =>
      useProviderLocations(
        [{ provider: 'lan', base_url: 'http://192.168.1.20:8080/v1' }],
        () => false
      )
    )
    await act(async () => {
      vi.advanceTimersByTime(RECHECK_MS * 2)
      await Promise.resolve()
    })
    expect(endpointDiagnostics).not.toHaveBeenCalled()
  })
})
