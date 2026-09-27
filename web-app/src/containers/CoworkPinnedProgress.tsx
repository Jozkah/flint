import { ChevronDown, ListChecks, PinOff } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { cleanTaskLabel, isResolved, planTasks } from '@/lib/todoLabels'
import type { TodoList } from '@/types/coworkSession'
import { PlanSteps, ProgressBar } from '@/containers/CoworkPlanStrip'

/**
 * The live plan, pinned under the session header so it never scrolls away:
 * one line with the count, the bar and the current step; the whole list opens
 * in place with its own scroll. Nothing without a plan.
 */
export function CoworkPinnedProgress({
  todos,
  expanded,
  onToggle,
  onUnpin,
}: {
  todos: TodoList | undefined
  expanded: boolean
  onToggle: () => void
  onUnpin: () => void
}) {
  const { t } = useTranslation()
  const tasks = planTasks(todos)
  if (tasks.length === 0) return null
  const done = tasks.filter(isResolved).length
  const pct = Math.round((done / tasks.length) * 100)
  const current = tasks.find((task) => task.status === 'in_progress')

  return (
    <section
      aria-label={t('common:todoPanelTitle')}
      data-testid="cowork-pinned-progress"
      className="mx-auto mt-2 w-full max-w-[756px] shrink-0 px-[18px]"
    >
      <div className="rounded-[10px] bg-card shadow-[inset_0_0_0_0.8px_var(--border)]">
        <div className="flex items-center">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            data-testid="cowork-pinned-progress-toggle"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-3 py-1.5 text-left text-[12.5px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:h-11"
          >
            <span className="shrink-0 font-semibold text-foreground">
              {t('common:todoPanelTitle')}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {done}/{tasks.length}
            </span>
            <ProgressBar pct={pct} className="w-16" />
            {current ? (
              <span className="min-w-0 truncate text-fg-2">
                {cleanTaskLabel(current.content)}
              </span>
            ) : null}
            <ChevronDown
              aria-hidden
              className={cn(
                'ml-auto size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-expo',
                expanded && 'rotate-180'
              )}
            />
          </button>
          <button
            type="button"
            onClick={onUnpin}
            aria-label={t('common:progressPin.unpin')}
            title={t('common:progressPin.unpin')}
            data-testid="cowork-pinned-progress-unpin"
            className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:size-11"
          >
            <PinOff aria-hidden className="size-3.5" />
          </button>
        </div>
        {expanded ? (
          <PlanSteps tasks={tasks} className="max-h-60 px-3 pb-2" />
        ) : null}
      </div>
    </section>
  )
}

/** Brings an unpinned plan back; lives in the session header. */
export function CoworkProgressButton({
  todos,
  onPin,
  compact,
}: {
  todos: TodoList | undefined
  onPin: () => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const tasks = planTasks(todos)
  if (tasks.length === 0) return null
  const done = tasks.filter(isResolved).length
  return (
    <button
      type="button"
      onClick={onPin}
      title={t('common:progressPin.pin')}
      aria-label={t('common:progressPin.pin')}
      data-testid="cowork-progress-button"
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground shadow-[inset_0_0_0_0.8px_var(--border)] outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:h-11',
        compact ? 'h-7' : 'h-8'
      )}
    >
      <ListChecks aria-hidden className="size-3.5" />
      <span>{t('common:todoPanelTitle')}</span>
      <span className="tabular-nums">
        {done}/{tasks.length}
      </span>
    </button>
  )
}
