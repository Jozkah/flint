import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useCampaignSettings } from '@/hooks/useCampaignSettings'
import {
  CAMPAIGN_MAX_PARALLEL_CAP,
  CAMPAIGN_MIN_PARALLEL,
} from '@/lib/campaignModel'

const OPTIONS = Array.from(
  { length: CAMPAIGN_MAX_PARALLEL_CAP - CAMPAIGN_MIN_PARALLEL + 1 },
  (_, i) => CAMPAIGN_MIN_PARALLEL + i
)

/**
 * Campaigns (docs/CAMPAIGNS.md): how many tasks may run at once. Read each
 * time the scheduler decides, so a change applies to a running campaign.
 * Free split panes still cap the effective value.
 */
export function CampaignSettings() {
  const { t } = useTranslation()
  return (
    <Card title={t('settings:campaigns.title')}>
      <CampaignParallelSetting />
    </Card>
  )
}

/** The parallel-tasks row alone, for a page that groups it with other runs. */
export function CampaignParallelSetting() {
  const { t } = useTranslation()
  const maxParallel = useCampaignSettings((s) => s.maxParallel)
  const setMaxParallel = useCampaignSettings((s) => s.setMaxParallel)
  const label = t('settings:campaigns.maxParallel')
  return (
      <CardItem
        anchor="settings-campaigns-max-parallel"
        title={label}
        description={t('settings:campaigns.maxParallelDesc')}
        actions={
          <select
            aria-label={label}
            data-testid="campaign-max-parallel"
            value={maxParallel}
            onChange={(e) => setMaxParallel(Number(e.target.value))}
            className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
          >
            {OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        }
      />
  )
}
