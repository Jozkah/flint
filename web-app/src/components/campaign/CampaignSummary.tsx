import { useState } from 'react'
import { ArrowRight, Check, Copy } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { BudgetBar } from '@/components/campaign/BudgetBar'
import { formatTokenCount } from '@/lib/utils'
import {
  campaignElapsedMs,
  formatDuration,
  planLevels,
} from '@/lib/campaignStory'
import { budgetOf } from '@/lib/campaignView'
import type { Campaign } from '@/lib/campaignModel'

export type ChangeTotals = { files: number; added: number; removed: number }

/**
 * The campaign in a few plain facts, replacing the old "Details": what was
 * asked, how it was split (which tasks ran side by side and which waited),
 * how long it took, what came out, one figure for the cost, and where the
 * results are collected, with a button to copy that branch name.
 */
export function CampaignSummary({
  campaign,
  totals,
  now,
}: {
  campaign: Campaign
  /** Files and lines changed across tasks, once known. */
  totals: ChangeTotals | null
  now?: number
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const levels = planLevels(campaign.tasks)
  const elapsed = campaignElapsedMs(campaign, now ?? Date.now())
  const budget = budgetOf(campaign)
  const branch = campaign.integrationBranch || campaign.baseBranch
  const finished = ['done', 'failed', 'cancelled'].includes(campaign.status)
  const merged = campaign.tasks.filter((x) => x.status === 'merged').length

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(branch)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable: the name is on screen to select */
    }
  }

  return (
    <section
      aria-label={t('settings:campaigns.board.summary.title')}
      data-testid="campaign-summary"
      className="flex flex-col gap-4 rounded-xl border-[0.8px] border-border p-4 text-sm"
    >
      <h2 className="text-sm font-medium">
        {t('settings:campaigns.board.summary.title')}
      </h2>

      <div className="flex flex-col gap-1">
        <h3 className="text-xs text-muted-foreground">
          {t('settings:campaigns.board.summary.goal')}
        </h3>
        <p data-testid="campaign-goal-text">{campaign.title}</p>
      </div>

      {levels.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="campaign-plan-map">
          <h3 className="text-xs text-muted-foreground">
            {t('settings:campaigns.board.summary.plan')}
          </h3>
          <ol className="flex flex-col gap-2">
            {levels.map((level) => (
              <li key={level.level} className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {level.level > 0 && <ArrowRight aria-hidden className="size-3" />}
                  {level.tasks.length > 1
                    ? t('settings:campaigns.board.summary.sideBySide', {
                        count: level.tasks.length,
                      })
                    : level.level === 0
                      ? t('settings:campaigns.board.summary.sideBySide', {
                          count: 1,
                        })
                      : t('settings:campaigns.board.summary.waitsFor', {
                          task: level.tasks[0].title,
                          tasks: level.tasks[0].waitsFor.join(', '),
                        })}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {level.tasks.map((x) => (
                    <span
                      key={x.id}
                      className="rounded-md bg-muted px-2 py-0.5 text-xs"
                      title={
                        x.waitsFor.length > 0
                          ? t('settings:campaigns.board.summary.waitsFor', {
                              task: x.title,
                              tasks: x.waitsFor.join(', '),
                            })
                          : undefined
                      }
                    >
                      {x.title}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">
            {t('settings:campaigns.board.summary.time')}
          </dt>
          <dd data-testid="campaign-elapsed">
            {elapsed == null
              ? '–'
              : t(
                  finished
                    ? 'settings:campaigns.board.summary.timeTotal'
                    : 'settings:campaigns.board.summary.timeSoFar',
                  { time: formatDuration(elapsed) }
                )}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">
            {t('settings:campaigns.board.summary.result')}
          </dt>
          <dd data-testid="campaign-result">
            {t('settings:campaigns.board.progressLabel', {
              done: merged,
              total: campaign.tasks.length,
            })}
            {totals && totals.files > 0
              ? ` · ${t('settings:campaigns.changes.files', { count: totals.files })}`
              : ''}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">
            {t('settings:campaigns.board.summary.cost')}
          </dt>
          <dd data-testid="campaign-cost">
            {budget.budget == null
              ? t('settings:campaigns.board.summary.costTokens', {
                  tokens: formatTokenCount(budget.used),
                })
              : t('settings:campaigns.board.summary.costBudget', {
                  tokens: formatTokenCount(budget.used),
                  budget: formatTokenCount(budget.budget),
                })}
          </dd>
          {budget.budget != null && <BudgetBar budget={budget} />}
        </div>
      </dl>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs text-muted-foreground">
          {t('settings:campaigns.board.summary.branch')}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground">
            {t('settings:campaigns.board.summary.branchBody', { branch })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copy()}
            data-testid="campaign-copy-branch"
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied
              ? t('settings:campaigns.board.summary.copied')
              : t('settings:campaigns.board.summary.copy')}
          </Button>
        </div>
      </div>
    </section>
  )
}

/** The friendly close: what got built and how much it touched. */
export function WrapUp({
  campaign,
  totals,
  action,
}: {
  campaign: Campaign
  totals: ChangeTotals | null
  /** The one primary button (Review changes), when there is one. */
  action?: React.ReactNode
}) {
  const { t } = useTranslation()
  const merged = campaign.tasks.filter((x) => x.status === 'merged').length
  const skipped = campaign.tasks.filter((x) => x.status === 'cancelled').length
  const review = campaign.status === 'reviewing'
  return (
    <section
      data-testid="campaign-wrapup"
      className="flex flex-col gap-3 rounded-xl border-[0.8px] border-success/40 bg-success/5 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">
            {t(
              review
                ? 'settings:campaigns.board.summary.wrapUp.reviewTitle'
                : 'settings:campaigns.board.summary.wrapUp.doneTitle'
            )}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('settings:campaigns.board.summary.wrapUp.built')}
          </p>
        </div>
        {action}
      </div>
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">
            {t('settings:campaigns.board.summary.wrapUp.tasks')}
          </dt>
          <dd className="tabular-nums">
            {merged} / {campaign.tasks.length}
            {skipped > 0
              ? ` · ${t('settings:campaigns.board.summary.wrapUp.skipped', { count: skipped })}`
              : ''}
          </dd>
        </div>
        {totals && (
          <>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t('settings:campaigns.board.summary.wrapUp.files')}
              </dt>
              <dd className="tabular-nums" data-testid="campaign-wrapup-files">
                {totals.files}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t('settings:campaigns.board.summary.wrapUp.lines')}
              </dt>
              <dd className="tabular-nums">
                +{totals.added} {'−'}
                {totals.removed}
              </dd>
            </div>
          </>
        )}
      </dl>
    </section>
  )
}
