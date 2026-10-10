import { createFileRoute, useParams } from '@tanstack/react-router'
import { CampaignBoard } from '@/components/campaign/Board'

export const Route = createFileRoute('/campaign/$campaignId')({
  component: CampaignRoute,
})

function CampaignRoute() {
  const { campaignId } = useParams({ from: '/campaign/$campaignId' })
  return <CampaignBoard campaignId={campaignId} />
}
