import { createFileRoute, useParams } from '@tanstack/react-router'
import { CampaignBoard } from '@/components/campaign/Board'
import { CoworkRunHost } from '@/containers/SplitConversation'

export const Route = createFileRoute('/campaign/$campaignId')({
  component: CampaignRoute,
})

function CampaignRoute() {
  const { campaignId } = useParams({ from: '/campaign/$campaignId' })
  // The board is not the Cowork route, so the runs of the panes it started
  // are driven by a hidden copy of their pages; see CoworkRunHost.
  return (
    <>
      <CampaignBoard campaignId={campaignId} />
      <CoworkRunHost />
    </>
  )
}
