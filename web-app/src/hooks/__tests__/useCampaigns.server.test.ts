import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => false }))
vi.mock('@/lib/serverTransportFlag', () => ({ isServerTransport: () => true }))
const probe = vi.hoisted(() => vi.fn())
vi.mock('@/lib/remoteRunner', () => ({ probeRunner: probe }))
vi.mock('@/lib/campaignApi', () => ({
  campaignApi: { refresh: vi.fn(), list: vi.fn(), skipped: vi.fn(), listWithSkipped: vi.fn() },
}))

import { resetListMode, useCampaignStore } from '../useCampaigns'
import { campaignApi } from '@/lib/campaignApi'

beforeEach(() => {
  resetListMode()
  probe.mockReset()
  vi.mocked(campaignApi.list).mockReset()
})

describe('campaigns on a Flint server', () => {
  it('asks once whether the server runs agents and never lists or logs when it does not', async () => {
    probe.mockResolvedValue({ agent: false })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await useCampaignStore.getState().refresh()
    await useCampaignStore.getState().refresh()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(campaignApi.list).not.toHaveBeenCalled()
    expect(useCampaignStore.getState()).toMatchObject({ unavailable: 'desktop', error: null })
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('lists as before when the server runs agents', async () => {
    probe.mockResolvedValue({ agent: true })
    vi.mocked(campaignApi.list).mockResolvedValue([])
    vi.mocked(campaignApi.skipped).mockResolvedValue([])
    await useCampaignStore.getState().refresh()
    expect(campaignApi.list).toHaveBeenCalled()
    expect(useCampaignStore.getState()).toMatchObject({ unavailable: null, loaded: true })
  })

  it('asks again after a failed probe, but remembers an old server without one', async () => {
    vi.mocked(campaignApi.list).mockResolvedValue([])
    vi.mocked(campaignApi.skipped).mockResolvedValue([])
    probe.mockRejectedValueOnce(new Error('Sign in required')).mockResolvedValueOnce({ agent: false })
    await useCampaignStore.getState().refresh()
    await useCampaignStore.getState().refresh()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(useCampaignStore.getState().unavailable).toBe('desktop')

    resetListMode()
    probe.mockReset().mockRejectedValue(new Error('Unknown command'))
    await useCampaignStore.getState().refresh()
    await useCampaignStore.getState().refresh()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not hang when the probe never answers', async () => {
    vi.useFakeTimers()
    try {
      probe.mockReturnValue(new Promise(() => undefined))
      vi.mocked(campaignApi.list).mockResolvedValue([])
      vi.mocked(campaignApi.skipped).mockResolvedValue([])
      const done = useCampaignStore.getState().refresh()
      await vi.advanceTimersByTimeAsync(120_000)
      await done
      expect(useCampaignStore.getState().loaded).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
