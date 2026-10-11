import { describe, expect, it, vi } from 'vitest'
import type { Campaign } from '@/lib/campaignModel'

vi.mock('@/lib/campaignApi', () => ({ campaignApi: { refresh: vi.fn(), list: vi.fn() } }))

import { settleProposals } from '../useCampaigns'

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
