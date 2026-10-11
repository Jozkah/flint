import { create } from 'zustand'

/**
 * Tasks an app restart interrupted and the runner picked up again on its own,
 * per campaign, until the person dismisses the notice on the board. In memory
 * only: it describes this launch, not the campaign.
 */
type ResumedState = {
  byCampaign: Record<string, string[]>
  record: (campaignId: string, taskIds: string[]) => void
  dismiss: (campaignId: string) => void
}

export const useCampaignResumed = create<ResumedState>()((set) => ({
  byCampaign: {},
  record: (campaignId, taskIds) => {
    if (taskIds.length === 0) return
    set((s) => ({
      byCampaign: { ...s.byCampaign, [campaignId]: taskIds },
    }))
  },
  dismiss: (campaignId) =>
    set((s) => {
      const rest = { ...s.byCampaign }
      delete rest[campaignId]
      return { byCampaign: rest }
    }),
}))
