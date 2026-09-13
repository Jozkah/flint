import { Activity, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ActivityProgress } from '@/lib/coworkActivity'

/**
 * Opens the activity rail, and stays out of the way until the session has
 * actually run something — the same rule the changes, plan and folder controls
 * follow. While work is in flight it spins and counts, so a long subagent run
 * is visible without opening the panel.
 *
 * The counts come from the canonical activity store, the same one the panel and
 * the inline workflow cards read, so the chip cannot show a number the panel
 * disagrees with.
 */
export function CoworkTasksChip({
  totals,
  open,
  onToggle,
}: {
  /** This session's totals, from the same store the panel reads. */
  totals: ActivityProgress
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const inFlight = totals.running + totals.queued
  if (inFlight === 0 && totals.finished === 0) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={open}
          aria-label={t('common:tasks.a11y', {
            running: totals.running,
            queued: totals.queued,
            finished: totals.finished,
          })}
          onClick={onToggle}
          className={cn('shrink-0', open && 'text-brand-text')}
        >
          {inFlight > 0 ? (
            <Loader2 className="size-3.5 shrink-0 motion-safe:animate-spin" />
          ) : (
            <Activity className="size-3.5 shrink-0" />
          )}
          <span className="font-mono tabular-nums text-muted-foreground">
            {inFlight > 0 ? inFlight : totals.finished}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('common:tasks.title')}</TooltipContent>
    </Tooltip>
  )
}
