import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { BudgetView } from '@/lib/campaignView'

const FILL: Record<BudgetView['level'], string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-yellow-500',
  over: 'bg-red-500',
  none: 'bg-muted-foreground/40',
}

const fmt = (n: number) => n.toLocaleString()

/** Tokens used against the campaign budget; the count is also written out. */
export function BudgetBar({
  budget,
  className,
}: {
  budget: BudgetView
  className?: string
}) {
  const { t } = useTranslation()
  const text =
    budget.budget == null
      ? t('settings:campaigns.board.budget.none', { used: fmt(budget.used) })
      : t('settings:campaigns.board.budget.used', {
          used: fmt(budget.used),
          budget: fmt(budget.budget),
        })
  return (
    <div className={cn('min-w-40', className)} data-testid="campaign-budget">
      <div
        role="progressbar"
        aria-label={t('settings:campaigns.board.budget.label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={budget.percent}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full', FILL[budget.level])}
          style={{ width: `${budget.budget == null ? 0 : budget.percent}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">{text}</p>
    </div>
  )
}
