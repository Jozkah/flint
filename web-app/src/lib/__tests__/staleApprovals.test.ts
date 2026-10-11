import { describe, expect, it } from 'vitest'
import { staleApprovalIds, type StaleContext } from '../staleApprovals'

const ctx = (over: Partial<StaleContext> = {}): StaleContext => ({
  now: 100_000,
  liveSessions: new Set(),
  sessions: new Map(),
  campaigns: new Map(),
  campaignsLoaded: true,
  ...over,
})
const ask = (over: Record<string, unknown> = {}) => ({
  requestId: 'r1',
  toolName: 'write',
  threadId: 's1',
  requestedAt: 0,
  ...over,
})

describe('staleApprovalIds', () => {
  it('drops a prompt of a cowork session that has no live run', () => {
    const c = ctx({ sessions: new Map([['s1', {}]]) })
    expect(staleApprovalIds([ask()], c)).toEqual(['r1'])
  })

  it('keeps a prompt whose run is live, and one that is too new', () => {
    const live = ctx({
      sessions: new Map([['s1', {}]]),
      liveSessions: new Set(['s1']),
    })
    expect(staleApprovalIds([ask()], live)).toEqual([])
    const fresh = ctx({ sessions: new Map([['s1', {}]]) })
    expect(staleApprovalIds([ask({ requestedAt: 95_000 })], fresh)).toEqual([])
  })

  it('keeps prompts of conversations that are not cowork sessions', () => {
    expect(staleApprovalIds([ask({ threadId: 'chat-1' })], ctx())).toEqual([])
  })

  it('drops a campaign plan approval once the campaign left planned', () => {
    const base = {
      sessions: new Map([['s1', { campaignId: 'c1' }]]),
      liveSessions: new Set(['s1']),
    }
    const plan = ask({ toolName: 'campaign_plan', input: { campaign_id: 'c1' } })
    expect(
      staleApprovalIds([plan], ctx({ ...base, campaigns: new Map([['c1', 'running']]) }))
    ).toEqual(['r1'])
    expect(
      staleApprovalIds([plan], ctx({ ...base, campaigns: new Map([['c1', 'planned']]) }))
    ).toEqual([])
  })

  it('drops a campaign merge approval once the campaign is done or gone', () => {
    const base = {
      sessions: new Map([['s1', { campaignId: 'c1' }]]),
      liveSessions: new Set(['s1']),
    }
    const merge = ask({ toolName: 'campaign_merge' })
    expect(
      staleApprovalIds([merge], ctx({ ...base, campaigns: new Map([['c1', 'done']]) }))
    ).toEqual(['r1'])
    expect(
      staleApprovalIds([merge], ctx({ ...base, campaigns: new Map([['c1', 'reviewing']]) }))
    ).toEqual([])
    expect(staleApprovalIds([merge], ctx({ ...base, campaignsLoaded: false }))).toEqual([])
  })
})
