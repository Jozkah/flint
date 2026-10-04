/* eslint-disable react-refresh/only-export-components */
import { Loader2 } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { formatCompactDuration } from '@/lib/duration'
import type { SubagentStats } from '@/lib/coworkSubagentStats'

/** `900`, `12.0K`, `1.3M`: a count with its unit letter once it needs one. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** The label-over-value strip: Input, Output, Time, Steps. */
export function StatStrip({
  stats,
  className,
  testId = 'subagent-stats',
}: {
  stats: SubagentStats
  className?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const approx = stats.approximate ? '~' : ''
  const cells: { key: string; label: string; value: string; title?: string }[] = []
  if (stats.totalTokens > 0) {
    cells.push({
      key: 'input',
      label: t('common:tasks.statLabelInput'),
      value: `${approx}${formatCount(stats.inputTokens)}`,
      title: stats.approximate ? t('common:tasks.statEstimated') : undefined,
    })
    cells.push({
      key: 'output',
      label: t('common:tasks.statLabelOutput'),
      value: `${approx}${formatCount(stats.outputTokens)}`,
      title: stats.approximate ? t('common:tasks.statEstimated') : undefined,
    })
  }
  cells.push({
    key: 'time',
    label: t('common:tasks.statLabelTime'),
    value: formatCompactDuration(Math.round(stats.elapsedMs / 1000), t),
  })
  cells.push({
    key: 'steps',
    label: t('common:tasks.statLabelSteps'),
    value: String(stats.tools.total),
    title: t('common:tasks.statStepsTip', { steps: stats.tools.total, turns: stats.turns }),
  })
  return (
    <dl
      data-testid={testId}
      className={cn('m-0 flex flex-wrap gap-x-4 gap-y-1 tabular-nums', className)}
    >
      {cells.map((c) => (
        <div key={c.key} title={c.title} data-stat={c.key} className="min-w-0">
          <dt className="text-[10.5px] leading-tight text-muted-foreground">{c.label}</dt>
          <dd className="m-0 text-[12.5px] leading-tight font-medium text-foreground">{c.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Which tools the child used, as small outlined chips ("read 3"), a failed
 * tool's chip outlined red with its failure count, a running one with a spinner;
 * then one clear phrase for what is running or failed, only when there is any.
 */
export function ToolChips({
  stats,
  className,
}: {
  stats: SubagentStats
  className?: string
}) {
  const { t } = useTranslation()
  const names = Object.keys(stats.tools.byTool)
  if (names.length === 0) return null
  const { active, failed } = stats.tools
  return (
    <div className={cn('space-y-1', className)} data-testid="subagent-tools">
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label={t('common:tasks.toolsUsed')}>
        {names.map((name) => {
          const count = stats.tools.byTool[name]
          const bad = stats.tools.failedByTool[name] ?? 0
          const live = (stats.tools.activeByTool[name] ?? 0) > 0
          return (
            <li
              key={name}
              data-tool={name}
              data-failed={bad > 0 ? 'true' : undefined}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border-[0.8px] px-1.5 py-px text-[11px]',
                bad > 0
                  ? 'border-destructive/60 text-destructive'
                  : 'border-border text-muted-foreground'
              )}
            >
              {live && <Loader2 size={10} aria-hidden className="motion-safe:animate-spin" />}
              {bad > 0
                ? t('common:tasks.toolChipFailed', { name, count, failed: bad })
                : t('common:tasks.toolChip', { name, count })}
            </li>
          )
        })}
      </ul>
      {(active > 0 || failed > 0) && (
        <p className="m-0 text-[11px] text-muted-foreground" data-testid="subagent-tools-status">
          {[
            active > 0 ? t('common:tasks.stepsRunning', { count: active }) : '',
            failed > 0 ? t('common:tasks.stepsFailed', { count: failed }) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  )
}
