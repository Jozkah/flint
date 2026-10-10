import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { LayoutDashboard } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import type { CampaignGroup, CampaignGroupRow } from '@/lib/campaignView'

/**
 * Campaigns under Cowork: a derived group per campaign with the coordinator
 * row and one row per task session. Not stored anywhere; the rows are the
 * sessions' ordinary rows, so they open and behave as usual.
 */
export function CampaignGroups({
  groups,
  renderRow,
}: {
  groups: CampaignGroup[]
  renderRow: (row: CampaignGroupRow) => ReactNode
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  if (groups.length === 0) return null
  return (
    <>
      {groups.map((group) => (
        <li
          key={group.campaignId}
          className="flex list-none flex-col"
          data-testid={`campaign-group-${group.campaignId}`}
        >
          <button
            type="button"
            title={t('settings:campaigns.board.openBoard')}
            aria-label={`${group.title}: ${t('settings:campaigns.board.openBoard')}`}
            onClick={() =>
              void navigate({
                to: route.campaignDetail,
                params: { campaignId: group.campaignId },
              })
            }
            className="group/campaign flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <LayoutDashboard aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{group.title}</span>
            <span
              className="shrink-0 font-normal tabular-nums"
              data-testid="campaign-group-progress"
            >
              {t('settings:campaigns.board.progress', {
                done: group.done,
                total: group.total,
                status: t(`settings:campaigns.board.status.${group.status}`),
              })}
            </span>
          </button>
          <ul className="flex flex-col gap-0.5 pl-2">
            {group.rows.map((row) => renderRow(row))}
          </ul>
        </li>
      ))}
    </>
  )
}
