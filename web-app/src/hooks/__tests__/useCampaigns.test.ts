import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Campaign } from '@/lib/campaignModel'

const backend = vi.hoisted(() => ({ present: true }))
vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => backend.present,
}))
vi.mock('@/lib/serverTransportFlag', () => ({
  isServerTransport: () => false,
}))
vi.mock('@/lib/campaignApi', () => ({
  campaignApi: {
    refresh: vi.fn(),
    list: vi.fn(),
    skipped: vi.fn(),
    listWithSkipped: vi.fn(),
  },
}))

import {
  POLL_ERROR_MS,
  POLL_IDLE_MS,
  pollDelay,
  resetListMode,
  settleProposals,
  useCampaignStore,
} from '../useCampaigns'
import { campaignApi } from '@/lib/campaignApi'

beforeEach(() => {
  // Most tests exercise the older two-call path: an app without the new command.
  resetListMode()
  vi.mocked(campaignApi.listWithSkipped).mockRejectedValue(
    'Command agent_campaign_list_with_skipped not found'
  )
})

const camp = (over: Partial<Campaign>): Campaign =>
  ({ id: 'c', status: 'running', tasks: [], ...over }) as unknown as Campaign

describe('settleProposals', () => {
  it('asks the backend about a merging campaign so an applied proposal reaches done', async () => {
    const refresh = vi.fn(async (id: string) => camp({ id, status: 'done' }))
    const out = await settleProposals(
      [
        camp({ id: 'a', status: 'merging', proposalId: 'p1' }),
        camp({ id: 'b', status: 'running' }),
        camp({ id: 'c', status: 'reviewing', proposalId: null }),
      ],
      refresh
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('a')
    expect(out.map((c) => c.status)).toEqual(['done', 'running', 'reviewing'])
  })

  it('keeps the listed record when the refresh fails', async () => {
    const out = await settleProposals(
      [camp({ id: 'a', status: 'merging', proposalId: 'p1' })],
      async () => {
        throw new Error('no')
      }
    )
    expect(out[0].status).toBe('merging')
  })
})

describe('useCampaignStore.refresh', () => {
  it('keeps the list when the skipped report fails', async () => {
    vi.mocked(campaignApi.list).mockResolvedValue([camp({ id: 'a' })])
    vi.mocked(campaignApi.skipped).mockRejectedValue(new Error('nope'))
    await useCampaignStore.getState().refresh()
    const s = useCampaignStore.getState()
    expect(s.error).toBeNull()
    expect(s.campaigns.map((c) => c.id)).toEqual(['a'])
    expect(s.skipped).toEqual([])
  })

  it('records skipped records next to the list', async () => {
    vi.mocked(campaignApi.list).mockResolvedValue([camp({ id: 'a' })])
    vi.mocked(campaignApi.skipped).mockResolvedValue([{ id: 'x', reason: 'bad' }])
    await useCampaignStore.getState().refresh()
    expect(useCampaignStore.getState().skipped).toEqual([{ id: 'x', reason: 'bad' }])
  })

  it('reports the real rejection text, and a non-list reply as an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(campaignApi.list).mockRejectedValue({ message: 'disk on fire' })
    await useCampaignStore.getState().refresh()
    expect(useCampaignStore.getState().error).toContain('disk on fire')
    vi.mocked(campaignApi.list).mockResolvedValue(undefined as never)
    await useCampaignStore.getState().refresh()
    expect(useCampaignStore.getState().error).toContain('not a list')
  })
})

describe('useCampaignStore.refresh failures', () => {
  beforeEach(() => {
    backend.present = true
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(campaignApi.list).mockReset()
    vi.mocked(campaignApi.skipped).mockResolvedValue([])
  })
  afterEach(() => vi.useRealTimers())

  it('retries once after a pause before showing an error', async () => {
    vi.mocked(campaignApi.list)
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce([camp({ id: 'a' })])
    const done = useCampaignStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    const s = useCampaignStore.getState()
    expect(campaignApi.list).toHaveBeenCalledTimes(2)
    expect(s.error).toBeNull()
    expect(s.campaigns.map((c) => c.id)).toEqual(['a'])
  })

  it('shows the real reason when the retry fails too', async () => {
    vi.mocked(campaignApi.list).mockRejectedValue({ message: 'still down' })
    const done = useCampaignStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(campaignApi.list).toHaveBeenCalledTimes(2)
    expect(useCampaignStore.getState().error).toContain('still down')
  })

  it('does not call the backend where there is none, and says so', async () => {
    backend.present = false
    await useCampaignStore.getState().refresh()
    const s = useCampaignStore.getState()
    expect(campaignApi.list).not.toHaveBeenCalled()
    expect(s.unavailable).toBe('desktop')
    expect(s.error).toBeNull()
    expect(s.loaded).toBe(true)
  })

  it('explains an app older than this page when the command is unknown', async () => {
    vi.mocked(campaignApi.list).mockRejectedValue(
      'Command agent_campaign_list not found'
    )
    const done = useCampaignStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    const s = useCampaignStore.getState()
    expect(s.unavailable).toBeNull()
    expect(s.staleApp).toBe(true)
    expect(s.error).toContain('agent_campaign_list not found')
  })

  it('also treats an ACL refusal (not allowed) as an app older than the page', async () => {
    vi.mocked(campaignApi.list).mockRejectedValue(
      'agent_campaign_list not allowed. Plugin not found'
    )
    const done = useCampaignStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(useCampaignStore.getState().staleApp).toBe(true)
  })

  it('gives up on a backend that never answers and says it timed out', async () => {
    vi.mocked(campaignApi.list).mockReturnValue(new Promise(() => {}))
    const done = useCampaignStore.getState().refresh()
    await vi.advanceTimersByTimeAsync(60_000)
    await done
    expect(useCampaignStore.getState().error).toMatch(/did not answer/i)
  })

  it('drops list entries that are not campaigns and reports them', async () => {
    vi.mocked(campaignApi.list).mockResolvedValue([
      camp({ id: 'ok' }),
      null,
      { id: 'no-tasks' },
      'junk',
    ] as never)
    await useCampaignStore.getState().refresh()
    const s = useCampaignStore.getState()
    expect(s.campaigns.map((c) => c.id)).toEqual(['ok'])
    expect(s.error).toBeNull()
    expect(s.skipped.length).toBe(3)
  })
})

describe('useCampaignStore.refresh with one listing call', () => {
  beforeEach(() => {
    backend.present = true
    resetListMode()
    vi.mocked(campaignApi.list).mockReset()
    vi.mocked(campaignApi.skipped).mockReset()
    vi.mocked(campaignApi.listWithSkipped).mockReset()
  })

  it('reads the list and the skipped report from a single backend call', async () => {
    vi.mocked(campaignApi.listWithSkipped).mockResolvedValue({
      campaigns: [camp({ id: 'a' })],
      skipped: [{ id: 'x', reason: 'bad' }],
    })
    await useCampaignStore.getState().refresh()
    await useCampaignStore.getState().refresh()
    const s = useCampaignStore.getState()
    expect(s.campaigns.map((c) => c.id)).toEqual(['a'])
    expect(s.skipped).toEqual([{ id: 'x', reason: 'bad' }])
    expect(campaignApi.listWithSkipped).toHaveBeenCalledTimes(2)
    expect(campaignApi.list).not.toHaveBeenCalled()
    expect(campaignApi.skipped).not.toHaveBeenCalled()
  })

  it('falls back to list + skipped on an app without the new command, and remembers', async () => {
    vi.mocked(campaignApi.listWithSkipped).mockRejectedValue(
      'Command agent_campaign_list_with_skipped not found'
    )
    vi.mocked(campaignApi.list).mockResolvedValue([camp({ id: 'a' })])
    vi.mocked(campaignApi.skipped).mockResolvedValue([{ id: 'x', reason: 'bad' }])
    await useCampaignStore.getState().refresh()
    await useCampaignStore.getState().refresh()
    const s = useCampaignStore.getState()
    expect(s.error).toBeNull()
    expect(s.staleApp).toBe(false)
    expect(s.campaigns.map((c) => c.id)).toEqual(['a'])
    expect(s.skipped).toEqual([{ id: 'x', reason: 'bad' }])
    expect(campaignApi.listWithSkipped).toHaveBeenCalledTimes(1)
    expect(campaignApi.list).toHaveBeenCalledTimes(2)
  })
})

describe('pollDelay', () => {
  it('asks again soon after a failed load, and idles otherwise', () => {
    expect(pollDelay([], 'boom')).toBe(POLL_ERROR_MS)
    expect(pollDelay([], null)).toBe(POLL_IDLE_MS)
    expect(pollDelay([camp({ id: 'a', status: 'done' })], 'stale')).toBe(POLL_IDLE_MS)
  })
})
