import { useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, Workflow } from 'lucide-react'
import { StatusDot } from '@/components/campaign/StatusDot'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { cn } from '@/lib/utils'
import type { CampaignGroup, CampaignGroupRow } from '@/lib/campaignView'

/**
 * Campaigns under Cowork: one derived group per campaign holding the
 * coordinator and every task session, and nothing else of the campaign
 * appears elsewhere in the list. Not stored anywhere; the rows are the
 * sessions' ordinary rows, so they open and behave as usual.
 *
 * The header names the campaign, says how far it is in plain words and opens
 * the board. A finished campaign folds to that one line (the chevron unfolds
 * it); a running one stays open.
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
  // Only what the person changed; the default follows the campaign's state.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  if (groups.length === 0) return null
  return (
    <>
      {groups.map((group) => {
        const open = toggled[group.campaignId] ?? !group.finished
        return (
          <li
            key={group.campaignId}
            className="flex list-none flex-col"
            data-testid={`campaign-group-${group.campaignId}`}
          >
            <div className="flex h-7 items-center gap-0.5">
              <button
                type="button"
                aria-expanded={open}
                aria-label={t(
                  open
                    ? 'settings:campaigns.board.fold'
                    : 'settings:campaigns.board.unfold',
                  { title: group.title }
                )}
                onClick={() =>
                  setToggled((s) => ({ ...s, [group.campaignId]: !open }))
                }
                className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'size-3 transition-transform',
                    open && 'rotate-90'
                  )}
                />
              </button>
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
                className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Workflow aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{group.title}</span>
                <StatusDot
                  dot={group.dot}
                  className={group.attention ? 'motion-safe:animate-pulse' : undefined}
                />
                <span
                  className="shrink-0 font-normal tabular-nums"
                  data-testid="campaign-group-progress"
                >
                  {group.finished
                    ? t(`settings:campaigns.board.statusWord.${group.status}`)
                    : t('settings:campaigns.board.groupProgress', {
                        done: group.done,
                        total: group.total,
                        status: t(
                          `settings:campaigns.board.statusWord.${group.status}`
                        ),
                      })}
                </span>
              </button>
            </div>
            {open && (
              <ul className="flex flex-col gap-0.5 pl-2">
                {group.rows.map((row) => renderRow(row))}
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
}
