import { useEffect } from 'react'
import { create } from 'zustand'
import { campaignApi } from '@/lib/campaignApi'
import type { Campaign } from '@/lib/campaignModel'
import { errorText } from '@/lib/errorText'

/**
 * The campaigns the backend knows, kept fresh by polling the Rust commands
 * (`agent_campaign_list`). The backend record is the truth; this is a read-only
 * mirror with no persistence of its own.
 */
type CampaignsState = {
  campaigns: Campaign[]
  loaded: boolean
  error: string | null
  refresh: () => Promise<void>
}

/** While anything is moving the board refreshes fast; otherwise it idles. */
export const POLL_ACTIVE_MS = 3_000
export const POLL_IDLE_MS = 15_000

const MOVING: ReadonlySet<string> = new Set([
  'approved',
  'running',
  'reviewing',
  'merging',
  'interrupted',
])

export function pollDelay(campaigns: readonly Campaign[]): number {
  return campaigns.some((c) => MOVING.has(c.status))
    ? POLL_ACTIVE_MS
    : POLL_IDLE_MS
}

/**
 * A campaign waiting on its proposal only reaches `done` (applied) or back to
 * `reviewing` (rejected) when the backend is asked to look at the proposal, so
 * each poll asks for every merging or reviewing campaign that has one.
 */
export async function settleProposals(
  campaigns: Campaign[],
  refresh: (id: string) => Promise<Campaign> = campaignApi.refresh
): Promise<Campaign[]> {
  return Promise.all(
    campaigns.map(async (c) => {
      const waiting =
        (c.status === 'merging' || c.status === 'reviewing') && !!c.proposalId
      if (!waiting) return c
      try {
        return await refresh(c.id)
      } catch {
        return c
      }
    })
  )
}

export const useCampaignStore = create<CampaignsState>()((set) => ({
  campaigns: [],
  loaded: false,
  error: null,
  refresh: async () => {
    try {
      const campaigns = await settleProposals(await campaignApi.list())
      set({ campaigns, loaded: true, error: null })
    } catch (e) {
      set({ loaded: true, error: errorText(e) })
    }
  },
}))

let subscribers = 0
let timer: ReturnType<typeof setTimeout> | null = null
// Which polling chain is current. A refresh still in flight when the last
// subscriber left belongs to an old chain and must not schedule another,
// or a remount would leave two chains polling.
let chain = 0

const schedule = (id: number) => {
  if (subscribers === 0 || id !== chain) return
  const { campaigns, refresh } = useCampaignStore.getState()
  timer = setTimeout(() => {
    void refresh().finally(() => schedule(id))
  }, pollDelay(campaigns))
}

function start() {
  subscribers += 1
  if (subscribers === 1) {
    const id = ++chain
    void useCampaignStore.getState().refresh().finally(() => schedule(id))
  }
}

function stop() {
  subscribers = Math.max(0, subscribers - 1)
  if (subscribers === 0 && timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** Subscribe to the list; polling runs while at least one component uses it. */
export function useCampaigns() {
  useEffect(() => {
    start()
    return stop
  }, [])
  return useCampaignStore()
}

export function useCampaign(id: string): Campaign | undefined {
  const { campaigns } = useCampaigns()
  return campaigns.find((c) => c.id === id)
}
