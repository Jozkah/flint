// RPC handlers for Campaigns. A phone reads the same campaign records the
// desktop's board does (through `agent_campaign_*`) and steers them with the
// board's own actions, so the backend still validates every move. The one
// mutating method is named `approvals.campaign.act`: the server gates every
// `approvals.*` name on "Approvals from phones", which is the right switch for
// something that can pause agents or apply their work to a checkout.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import type { CampaignActionWire, CampaignDetailResult, CampaignWire } from './protocol'

export type RemoteCampaigns = {
  list(): Promise<CampaignWire[]>
  get(id: string): Promise<CampaignDetailResult>
  act(
    id: string,
    action: CampaignActionWire,
    opts: { taskId?: string; acknowledged?: string[] }
  ): Promise<{ ok: true; note?: string }>
}

export type CampaignMethods = 'campaigns.list' | 'campaigns.get' | 'approvals.campaign.act'

export const CAMPAIGN_ACTIONS: readonly CampaignActionWire[] = [
  'pause',
  'resume',
  'cancel',
  'finalize',
  'apply',
  'retry',
  'skip',
  'stop',
]

/** Actions that name a task. */
const TASK_ACTIONS: readonly CampaignActionWire[] = ['retry', 'skip', 'stop']

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

function idOf(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 120) {
    throw new RemoteRpcError('bad_params', `${what} is required`)
  }
  return v
}

export function createCampaignHandlers(c?: RemoteCampaigns): Pick<RemoteHandlers, CampaignMethods> {
  const campaigns = (): RemoteCampaigns => {
    if (!c) throw new RemoteRpcError('not_implemented', 'Campaigns are not available from phones yet')
    return c
  }
  // The board's refusals carry their reason ("the campaign is paused, not reviewing").
  const refused = (e: unknown) =>
    e instanceof RemoteRpcError
      ? e
      : new RemoteRpcError('refused', e instanceof Error ? e.message : String(e))
  return {
    'campaigns.list': async () => ({ campaigns: await campaigns().list().catch((e) => { throw refused(e) }) }),
    'campaigns.get': async (params) => {
      const id = idOf(rec(params).id, 'id')
      return campaigns().get(id).catch((e) => {
        throw refused(e)
      })
    },
    'approvals.campaign.act': async (params) => {
      const p = rec(params)
      const id = idOf(p.id, 'id')
      const action = p.action as CampaignActionWire
      if (!CAMPAIGN_ACTIONS.includes(action)) throw new RemoteRpcError('bad_params', 'Not a campaign action')
      const taskId = TASK_ACTIONS.includes(action) ? idOf(p.taskId, 'taskId') : undefined
      const acknowledged = Array.isArray(p.acknowledged)
        ? p.acknowledged.filter((x): x is string => typeof x === 'string' && x.length <= 500).slice(0, 300)
        : undefined
      return campaigns()
        .act(id, action, { taskId, acknowledged })
        .catch((e) => {
          throw refused(e)
        })
    },
  }
}
