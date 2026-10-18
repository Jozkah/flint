import { useEffect } from 'react'
import { create } from 'zustand'
import { campaignApi, type SkippedRecord } from '@/lib/campaignApi'
import type { Campaign } from '@/lib/campaignModel'
import { errorText } from '@/lib/errorText'
import { isPlatformTauri } from '@/lib/platform/utils'
import { isServerTransport } from '@/lib/serverTransportFlag'

/**
 * The campaigns the backend knows, kept fresh by polling the Rust commands
 * (`agent_campaign_list`). The backend record is the truth; this is a read-only
 * mirror with no persistence of its own.
 */
type CampaignsState = {
  campaigns: Campaign[]
  loaded: boolean
  error: string | null
  /** No backend to ask: a plain browser tab, not the app or a Flint server. */
  unavailable: 'desktop' | null
  /** The app answered "no such command": it is older than this page. */
  staleApp: boolean
  /** Records the backend could not read; the rest of the list still loads. */
  skipped: SkippedRecord[]
  refresh: () => Promise<void>
}

/** While anything is moving the board refreshes fast; otherwise it idles. */
export const POLL_ACTIVE_MS = 3_000
export const POLL_IDLE_MS = 15_000

/** A backend that never answers must not leave the page loading forever. */
export const LIST_TIMEOUT_MS = 20_000
/** One more try after this pause, then the reason is shown. */
export const RETRY_PAUSE_MS = 1_000

const MOVING: ReadonlySet<string> = new Set([
  'approved',
  'running',
  'reviewing',
  'merging',
  'interrupted',
])

/** A failed load is asked again soon, so a backend still starting up recovers by itself. */
export const POLL_ERROR_MS = 5_000

export function pollDelay(
  campaigns: readonly Campaign[],
  error: string | null = null
): number {
  if (error && campaigns.length === 0) return POLL_ERROR_MS
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

const hasBackend = () => isPlatformTauri() || isServerTransport()

/** The command is not registered in this app (a build older than the page). */
const isUnknownCommand = (message: string) =>
  /\bagent_campaign_\w+\b.*\bnot (found|allowed)|command .*not found/i.test(message)

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('The app did not answer in time.')),
      LIST_TIMEOUT_MS
    )
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** Only objects shaped like a campaign reach the page; the rest are reported. */
function splitCampaigns(listed: unknown[]): {
  ok: Campaign[]
  bad: SkippedRecord[]
} {
  const ok: Campaign[] = []
  const bad: SkippedRecord[] = []
  listed.forEach((item, i) => {
    const c = item as Partial<Campaign> | null
    if (c && typeof c === 'object' && typeof c.id === 'string' && Array.isArray(c.tasks)) {
      ok.push(c as Campaign)
    } else {
      bad.push({
        id: c && typeof c === 'object' && typeof c.id === 'string' ? c.id : `#${i + 1}`,
        reason: 'the backend sent a record this page cannot read',
      })
    }
  })
  return { ok, bad }
}

/** False once the app turned out not to have `agent_campaign_list_with_skipped`. */
let combinedListing = true

/** For tests. */
export function resetListMode(): void {
  combinedListing = true
}

/**
 * The campaign records and the skipped report. One backend call where the app
 * has it (each call loads and reconciles every record on disk, and this runs
 * every few seconds); an older app, or a Flint server, takes the two older
 * commands instead.
 */
async function listOnce(): Promise<{ listed: unknown[]; skipped: SkippedRecord[] }> {
  if (combinedListing && !isServerTransport()) {
    try {
      const both = await withTimeout(campaignApi.listWithSkipped())
      if (!both || !Array.isArray(both.campaigns)) {
        throw new Error('agent_campaign_list_with_skipped returned an unreadable reply')
      }
      return {
        listed: both.campaigns,
        skipped: Array.isArray(both.skipped) ? both.skipped : [],
      }
    } catch (e) {
      if (!isUnknownCommand(errorText(e))) throw e
      combinedListing = false
    }
  }
  const listed: unknown = await withTimeout(campaignApi.list())
  if (!Array.isArray(listed)) {
    throw new Error(
      `agent_campaign_list returned ${listed === null ? 'null' : typeof listed}, not a list`
    )
  }
  // The skipped report is extra: failing to get it never hides the list.
  const skipped = await campaignApi.skipped().catch(() => [])
  return { listed, skipped: Array.isArray(skipped) ? skipped : [] }
}

export const useCampaignStore = create<CampaignsState>()((set) => ({
  campaigns: [],
  loaded: false,
  error: null,
  unavailable: null,
  staleApp: false,
  skipped: [],
  refresh: async () => {
    if (!hasBackend()) {
      set({ loaded: true, error: null, unavailable: 'desktop', staleApp: false })
      return
    }
    try {
      let got: Awaited<ReturnType<typeof listOnce>>
      try {
        got = await listOnce()
      } catch (first) {
        console.error('[campaigns] list failed, retrying once:', first)
        await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS))
        got = await listOnce()
      }
      const { ok, bad } = splitCampaigns(got.listed)
      const campaigns = await settleProposals(ok)
      set({
        campaigns,
        skipped: [...got.skipped, ...bad],
        loaded: true,
        error: null,
        unavailable: null,
        staleApp: false,
      })
    } catch (e) {
      console.error('[campaigns] could not load the list:', e)
      const error = errorText(e)
      set({
        loaded: true,
        error,
        unavailable: null,
        staleApp: isUnknownCommand(error),
      })
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
  const { campaigns, error, refresh } = useCampaignStore.getState()
  timer = setTimeout(() => {
    void refresh().finally(() => schedule(id))
  }, pollDelay(campaigns, error))
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
