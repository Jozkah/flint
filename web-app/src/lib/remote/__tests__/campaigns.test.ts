import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dispatchRemoteRpc, type RemoteHandlers } from '../bridge'
import { createCampaignHandlers, CAMPAIGN_ACTIONS, type RemoteCampaigns } from '../campaigns'
import { createRemoteHandlers } from '../handlers'
import type { RemoteSources } from '../handlers'

const device = { id: 'd1', name: 'Pixel' }
let handlers: RemoteHandlers
const call = (method: string, params: unknown) =>
  dispatchRemoteRpc({ id: 'x', method, params, device }, handlers)

describe('campaign handlers', () => {
  let c: RemoteCampaigns
  beforeEach(() => {
    c = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({
        campaign: {
          id: 'c1',
          title: 'T',
          status: 'running',
          coordinatorSession: 's0',
          updatedAt: '2026-10-11T00:00:00Z',
          tasks: [],
          maxParallel: 4,
          tokenBudget: null,
          tokensUsed: 0,
          proposalId: null,
          gate: null,
        },
        proposal: null,
        gateCommand: null,
      })),
      act: vi.fn(async () => ({ ok: true as const })),
    }
    handlers = createCampaignHandlers(c) as unknown as RemoteHandlers
  })

  it('lists and reads by id', async () => {
    expect(await call('campaigns.list', {})).toEqual({ result: { campaigns: [] } })
    expect(await call('campaigns.get', { id: 'c1' })).toMatchObject({ result: { campaign: { id: 'c1' } } })
    expect(await call('campaigns.get', {})).toMatchObject({ error: { code: 'bad_params' } })
  })

  it('every mutation travels under an approvals name, so the server gate covers it', () => {
    // check_policy in src-tauri/src/core/remote/hub.rs gates on this prefix.
    expect(Object.keys(handlers).filter((m) => !m.startsWith('campaigns.'))).toEqual(['approvals.campaign.act'])
  })

  it('passes a known action with its task and refuses the rest', async () => {
    expect(await call('approvals.campaign.act', { id: 'c1', action: 'retry', taskId: 't1' })).toEqual({ result: { ok: true } })
    expect(c.act).toHaveBeenCalledWith('c1', 'retry', { taskId: 't1', acknowledged: undefined })
    await call('approvals.campaign.act', { id: 'c1', action: 'apply', acknowledged: ['a.ts', 7, 'b.ts'] })
    expect(c.act).toHaveBeenLastCalledWith('c1', 'apply', { taskId: undefined, acknowledged: ['a.ts', 'b.ts'] })
    for (const params of [
      { id: 'c1', action: 'delete' },
      { id: 'c1', action: 'retry' },
      { action: 'pause' },
      { id: '', action: 'pause' },
    ]) {
      expect(await call('approvals.campaign.act', params)).toMatchObject({ error: { code: 'bad_params' } })
    }
    expect(CAMPAIGN_ACTIONS).toContain('apply')
  })

  it('carries the board refusal to the phone instead of "internal"', async () => {
    c.act = vi.fn(async () => {
      throw new Error('the campaign is paused, not reviewing')
    })
    handlers = createCampaignHandlers(c) as unknown as RemoteHandlers
    expect(await call('approvals.campaign.act', { id: 'c1', action: 'finalize' })).toEqual({
      error: { code: 'refused', message: 'the campaign is paused, not reviewing' },
    })
  })

  it('answers not_implemented when the window has no campaigns source', async () => {
    handlers = createCampaignHandlers() as unknown as RemoteHandlers
    expect(await call('campaigns.list', {})).toMatchObject({ error: { code: 'not_implemented' } })
  })

  it('is part of the full handler set the bridge dispatches', () => {
    const all = createRemoteHandlers({} as RemoteSources, undefined, undefined, undefined, undefined, undefined, c)
    expect(Object.keys(all)).toEqual(expect.arrayContaining(['campaigns.list', 'campaigns.get', 'approvals.campaign.act']))
  })
})
