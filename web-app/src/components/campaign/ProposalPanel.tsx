import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { CoworkProposalReview } from '@/containers/CoworkProposalReview'
import { campaignApi } from '@/lib/campaignApi'
import { useCampaignStore } from '@/hooks/useCampaigns'
import { listProposals, type ProposalRecord } from '@/lib/proposals'
import type { Campaign } from '@/lib/campaignModel'

/**
 * The campaign's one proposal, reviewed and applied in the board itself.
 *
 * The backend stored it against the user's checkout when the gate passed. This
 * finds it by the id on the campaign record and hands it to the ordinary
 * proposal review (file and hunk choice, conflicts, the apply approval), so
 * applying here is the same approval path as everywhere else. After an apply
 * or a reject the campaign record is refreshed, which moves it to `done` or
 * back to `reviewing`.
 */
export function CampaignProposalPanel({ campaign }: { campaign: Campaign }) {
  const { t } = useTranslation()
  const [proposal, setProposal] = useState<ProposalRecord | null | undefined>(
    undefined
  )
  const proposalId = campaign.proposalId

  const load = useCallback(async () => {
    if (!proposalId) {
      setProposal(null)
      return
    }
    // A failed read must not leave the board on "loading" forever.
    const all = await listProposals(campaign.sourceRoot).catch(() => [])
    setProposal(all.find((p) => p.id === proposalId) ?? null)
  }, [proposalId, campaign.sourceRoot])

  useEffect(() => {
    void load()
  }, [load])

  const settle = useCallback(async () => {
    await campaignApi.refresh(campaign.id).catch(() => undefined)
    await useCampaignStore.getState().refresh()
    await load()
  }, [campaign.id, load])

  if (!proposalId) return null
  if (proposal === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('settings:campaigns.board.proposal.loading')}
      </p>
    )
  }
  if (proposal === null) {
    return (
      <p className="text-xs text-destructive" role="alert">
        {t('settings:campaigns.board.proposal.missing')}
      </p>
    )
  }
  return (
    <div
      className="max-h-[60%] min-h-0 shrink-0 overflow-y-auto rounded-xl"
      data-testid="campaign-proposal"
    >
      <CoworkProposalReview
        worktree={{
          path: proposal.scope.worktree,
          sourceRoot: proposal.scope.project,
        }}
        session={campaign.coordinatorSession}
        title={t('settings:campaigns.board.proposal.title')}
        onApplied={() => void settle()}
      />
    </div>
  )
}
