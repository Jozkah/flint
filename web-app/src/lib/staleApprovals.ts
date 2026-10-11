import {
  CAMPAIGN_MERGE_TOOL_NAME,
  CAMPAIGN_PLAN_TOOL_NAME,
} from '@/lib/campaignToolNames'

/** A request must be this old before it can be called stale. */
export const STALE_APPROVAL_GRACE_MS = 15_000

type Ask = {
  requestId: string
  toolName: string
  threadId: string
  input?: unknown
  requestedAt?: number
}

export type StaleContext = {
  now: number
  /** Cowork session ids that have a run in progress. */
  liveSessions: ReadonlySet<string>
  /** Every Cowork session id, with the campaign it points at if any. */
  sessions: ReadonlyMap<string, { campaignId?: string }>
  /** Campaign id -> status; only meaningful once the list has loaded. */
  campaigns: ReadonlyMap<string, string>
  campaignsLoaded: boolean
  graceMs?: number
}

/** The states in which a campaign still waits on each campaign approval. */
const PLAN_STATES = new Set(['draft', 'planned'])
const MERGE_STATES = new Set(['reviewing', 'merging'])

/**
 * Request ids of approvals nobody can answer any more: the Cowork run that
 * asked is gone (the app restarted, or the run ended without withdrawing the
 * prompt), or the campaign moved past the state the approval was about. Real
 * pending prompts, whose run is live and campaign still waiting, are kept.
 */
export function staleApprovalIds(
  asks: readonly Ask[],
  ctx: StaleContext
): string[] {
  const grace = ctx.graceMs ?? STALE_APPROVAL_GRACE_MS
  const out: string[] = []
  for (const a of asks) {
    if (a.requestedAt === undefined || ctx.now - a.requestedAt < grace) continue
    const session = ctx.sessions.get(a.threadId)
    if (session && !ctx.liveSessions.has(a.threadId)) {
      out.push(a.requestId)
      continue
    }
    if (!ctx.campaignsLoaded) continue
    const named = (a.input as { campaign_id?: unknown } | undefined)
      ?.campaign_id
    const id = typeof named === 'string' ? named : session?.campaignId
    if (!id) continue
    const status = ctx.campaigns.get(id)
    if (a.toolName === CAMPAIGN_PLAN_TOOL_NAME) {
      if (status === undefined || !PLAN_STATES.has(status)) {
        // A plan card raised before the campaign exists has no id to check.
        if (typeof named === 'string' || status !== undefined) {
          out.push(a.requestId)
        }
      }
    } else if (a.toolName === CAMPAIGN_MERGE_TOOL_NAME) {
      if (status === undefined || !MERGE_STATES.has(status)) {
        out.push(a.requestId)
      }
    }
  }
  return out
}
