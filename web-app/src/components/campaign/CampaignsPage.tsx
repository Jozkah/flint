import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Plus, Workflow } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import HeaderPage from '@/containers/HeaderPage'
import { StatusDot } from '@/components/campaign/StatusDot'
import { StartCampaignDialog } from '@/components/campaign/StartCampaignDialog'
import { useCampaigns } from '@/hooks/useCampaigns'
import { useCampaignFolderState } from '@/hooks/useCampaignFolder'
import { route } from '@/constants/routes'
import { coordinatorDotOf } from '@/lib/campaignView'
import { timeAgo } from '@/containers/rooms/roomUi'
import type { Campaign } from '@/lib/campaignModel'

const doneOf = (c: Campaign) => c.tasks.filter((t) => t.status === 'merged').length

/**
 * The Campaigns overview, in the layout of the Rooms overview: a title, one
 * primary "Start a campaign" button, and the campaigns as rows that open their
 * board. A campaign is described in one friendly sentence when there are none.
 */
export function CampaignsPage() {
  const { t, i18n } = useTranslation()
  const lang = (i18n as { language?: string } | undefined)?.language || 'en'
  const navigate = useNavigate()
  const { campaigns, loaded, error, skipped, refresh, unavailable, staleApp } =
    useCampaigns()
  const { folder, isRepo } = useCampaignFolderState()
  const [startOpen, setStartOpen] = useState(false)
  // Known not to be a repository: the button says why it cannot start.
  const blocked = isRepo === false
  const noBackend = unavailable === 'desktop'
  const sorted = [...campaigns].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  )

  const startButton = (
    <Button
      size="sm"
      className="pointer-coarse:h-11"
      disabled={blocked || noBackend}
      onClick={() => setStartOpen(true)}
      data-testid="campaigns-start"
    >
      <Plus aria-hidden />
      {t('settings:campaigns.list.start')}
    </Button>
  )

  return (
    <div className="flex h-full flex-col" data-testid="campaigns-page">
      <HeaderPage />
      <div className="h-full overflow-y-auto">
        <div className="flex w-full flex-col gap-5 px-1 py-4">
          <div className="flex flex-wrap items-end gap-3 motion-safe:animate-rise-in">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.01em] text-foreground">
                {t('settings:campaigns.nav')}
              </h1>
              <p className="text-[13px] text-muted-foreground">
                {t('settings:campaigns.list.subtitle')}
              </p>
            </div>
            {startButton}
          </div>
          {blocked && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="campaigns-not-git"
            >
              {t('settings:campaigns.start.noFolder')}
            </p>
          )}
          {loaded && skipped.length > 0 && (
            <div
              role="status"
              data-testid="campaigns-skipped"
              className="rounded-xl border-[0.8px] border-border px-4 py-3 text-xs text-muted-foreground"
            >
              <p>{t('settings:campaigns.list.skipped', { count: skipped.length })}</p>
              <ul className="mt-1 list-disc pl-4">
                {skipped.map((r) => (
                  <li key={r.id} className="break-words">
                    {r.id}: {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!loaded ? (
            <div
              role="status"
              aria-busy="true"
              aria-label={t('settings:campaigns.list.loading')}
              data-testid="campaigns-loading"
              className="flex flex-col gap-2"
            >
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[74px] rounded-xl" />
              ))}
            </div>
          ) : noBackend ? (
            <EmptyState
              className="rounded-xl border-[0.8px] border-dashed border-border-strong py-12"
              icon={<Workflow />}
              title={t('settings:campaigns.list.needsDesktop')}
              description={t('settings:campaigns.list.needsDesktopHint')}
            />
          ) : error && sorted.length === 0 ? (
            <div
              role="alert"
              data-testid="campaigns-error"
              className="flex flex-col items-start gap-2 rounded-xl border-[0.8px] border-border px-4 py-6 text-sm"
            >
              <p>{t('settings:campaigns.list.loadFailed')}</p>
              <p
                data-testid="campaigns-error-reason"
                className="break-words text-muted-foreground"
              >
                {error}
              </p>
              {staleApp && (
                <p
                  data-testid="campaigns-stale-app"
                  className="text-xs text-muted-foreground"
                >
                  {t('settings:campaigns.list.staleApp')}
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                data-testid="campaigns-retry"
                onClick={() => void refresh()}
              >
                {t('settings:campaigns.list.retry')}
              </Button>
            </div>
          ) : sorted.length === 0 ? (
            <EmptyState
              className="rounded-xl border-[0.8px] border-dashed border-border-strong py-12"
              icon={<Workflow />}
              title={t('settings:campaigns.list.empty')}
              description={t('settings:campaigns.list.emptyHint')}
              action={startButton}
            />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="campaigns-list">
              {sorted.map((c) => {
                const total = c.tasks.length
                const done = doneOf(c)
                const updated = Date.parse(c.updatedAt)
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      data-testid={`campaigns-row-${c.id}`}
                      onClick={() =>
                        void navigate({
                          to: route.campaignDetail,
                          params: { campaignId: c.id },
                        })
                      }
                      className="flex w-full cursor-pointer flex-col gap-2 rounded-xl border-[0.8px] border-border bg-card px-4 py-3 text-left outline-hidden motion-safe:transition-[background-color,box-shadow] duration-150 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40"
                    >
                      <span className="flex items-center gap-2">
                        <StatusDot dot={coordinatorDotOf(c)} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {c.title}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t(`settings:campaigns.board.statusWord.${c.status}`)}
                        </span>
                      </span>
                      <span className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          {total > 0
                            ? t('settings:campaigns.list.doneOf', { done, total })
                            : t('settings:campaigns.list.planning')}
                        </span>
                        {Number.isNaN(updated) ? null : (
                          <span>
                            {t('settings:campaigns.list.updated', {
                              when: timeAgo(updated, lang),
                            })}
                          </span>
                        )}
                      </span>
                      {total > 0 && (
                        <Progress
                          value={Math.round((done / total) * 100)}
                          aria-label={t('settings:campaigns.board.progressLabel', {
                            done,
                            total,
                          })}
                        />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
      <StartCampaignDialog
        open={startOpen}
        onOpenChange={setStartOpen}
        folder={blocked ? null : folder}
      />
    </div>
  )
}
