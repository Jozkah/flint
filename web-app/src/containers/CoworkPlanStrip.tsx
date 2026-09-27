import { useState } from 'react'
import { Check, ChevronDown, Minus } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { cleanTaskLabel, isResolved, planTasks } from '@/lib/todoLabels'
import type { TodoItem, TodoList, TodoStatus } from '@/types/coworkSession'

/**
 * The plan as it stood at one turn of the conversation: a compact, read-only
 * card in the transcript, so history shows what the plan was. The live plan
 * is the pinned strip over the transcript.
 *
 * Done steps carry a check in the success colour, open ones a ring, and the
 * current step is marked by a 2px warm edge: it says "this is the one in
 * focus", not "busy", so nothing in the strip spins or pulses.
 */
export function CoworkPlanStrip({
  todos,
  defaultOpen = true,
  snapshot = false,
}: {
  todos: TodoList | undefined
  defaultOpen?: boolean
  /** A record of the plan at this turn, rather than the live one. */
  snapshot?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)
  const tasks = planTasks(todos)
  if (tasks.length === 0) return null

  const done = tasks.filter(isResolved).length
  const pct = Math.round((done / tasks.length) * 100)

  return (
    <section
      aria-label={t('common:todoPanelTitle')}
      data-testid={snapshot ? 'cowork-plan-snapshot' : 'cowork-plan-strip'}
      className="my-2 shrink-0 rounded-[10px] shadow-[inset_0_0_0_0.8px_var(--border)]"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[12.5px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:h-11"
      >
        <span className="font-semibold text-foreground">
          {t('common:todoPanelTitle')}
        </span>
        <span
          className="text-muted-foreground tabular-nums"
          data-testid="cowork-plan-count"
        >
          {t('results:plan.progress', { done, total: tasks.length })}
        </span>
        <ProgressBar pct={pct} className="w-[120px]" />
        <ChevronDown
          aria-hidden
          className={cn(
            'ml-auto size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-expo',
            open && 'rotate-180'
          )}
        />
      </button>
      {open ? <PlanSteps tasks={tasks} className="max-h-40 px-3 pb-2" /> : null}
    </section>
  )
}

export function ProgressBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('h-1.5 shrink-0 overflow-hidden rounded-full bg-track', className)}
    >
      <span
        className="block h-full rounded-full bg-grad motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-expo"
        style={{ width: `${pct}%` }}
      />
    </span>
  )
}

/** The steps of a plan, one row each. */
export function PlanSteps({
  tasks,
  className,
}: {
  tasks: TodoItem[]
  className?: string
}) {
  return (
    <ol className={cn('overflow-y-auto', className)}>
      {tasks.map((task, index) => (
        <li
          key={`${index}-${task.content}`}
          data-status={task.status}
          aria-current={task.status === 'in_progress' ? 'step' : undefined}
          className={cn(
            'flex min-h-7 items-center gap-2.5 text-[12.5px]',
            task.status === 'in_progress' &&
              '-ml-3 pl-3 font-semibold text-foreground shadow-[inset_2px_0_0_#fb923c]',
            task.status === 'pending' && 'text-fg-2',
            isResolved(task) && 'text-subtle-foreground'
          )}
        >
          <StepMark status={task.status} />
          <span className="min-w-0 flex-1 truncate">
            {cleanTaskLabel(task.content)}
          </span>
        </li>
      ))}
    </ol>
  )
}

function StepMark({ status }: { status: TodoStatus }) {
  const base = 'flex size-4 shrink-0 items-center justify-center'
  if (status === 'completed')
    return (
      <span className={cn(base, 'text-success')}>
        <Check aria-hidden className="size-3.5" strokeWidth={2.5} />
      </span>
    )
  if (status === 'abandoned')
    return (
      <span className={cn(base, 'text-muted-foreground')}>
        <Minus aria-hidden className="size-3.5" />
      </span>
    )
  return (
    <span className={base}>
      <span
        aria-hidden
        className={cn(
          'size-3 rounded-full border-[1.5px]',
          status === 'in_progress'
            ? 'size-3.5 border-2 border-foreground'
            : 'border-border-strong'
        )}
      />
    </span>
  )
}

export default CoworkPlanStrip
