import { useEffect } from 'react'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCampaignStore } from '@/hooks/useCampaigns'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { staleApprovalIds } from '@/lib/staleApprovals'

const SWEEP_MS = 5_000

/**
 * Withdraws prompts nobody can answer any more, so a leftover plan or merge
 * approval does not sit in the header after its run or campaign is gone.
 * Mounted once, in the header.
 */
export function useStaleApprovalSweep(): void {
  useEffect(() => {
    const sweep = () => {
      const approvals = useToolApprovalRequests.getState()
      const asks = allApprovalRequests(approvals)
      if (asks.length === 0) return
      const campaignState = useCampaignStore.getState()
      const ids = staleApprovalIds(asks, {
        now: Date.now(),
        liveSessions: new Set(Object.keys(useCoworkRun.getState().runs ?? {})),
        sessions: new Map(
          useCoworkSessions
            .getState()
            .sessions.map((s) => [s.id, { campaignId: s.campaign?.id }])
        ),
        campaigns: new Map(
          campaignState.campaigns.map((c) => [c.id, c.status as string])
        ),
        campaignsLoaded: campaignState.loaded,
      })
      for (const id of ids) approvals.withdrawApproval(id)
    }
    const timer = setInterval(sweep, SWEEP_MS)
    return () => clearInterval(timer)
  }, [])
}
