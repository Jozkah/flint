import { createFileRoute } from '@tanstack/react-router'
import { CampaignsPage } from '@/components/campaign/CampaignsPage'

export const Route = createFileRoute('/campaigns/')({
  component: CampaignsPage,
})
