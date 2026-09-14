import { useState } from 'react'
import { Check, ChevronDown, Minus } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { cleanTaskLabel } from '@/lib/todoLabels'
import type { TodoList, TodoStatus } from '@/types/coworkSession'

/**
 * The session's plan, as a compact strip over the conversation.
 *
 * A projection of the model's `todo` list, read-only. Done steps carry a check
 * in the success colour, open ones a ring, and the current step is marked by a
 * 2px accent edge: the accent says "this is the one in focus", not "busy", so
 * nothing in the strip spins or pulses.
 */
export function CoworkPlanStrip({ todos }: { todos: TodoList | undefined }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const tasks = (todos?.phases ?? []).flatMap((phase) => phase.tasks)
  if (tasks.length === 0) return null

  const done = tasks.filter(
    (task) => task.status === 'completed' || task.status === 'abandoned'
  ).length
  const pct = Math.round((done / tasks.length) * 100)

  return (
    <section
      aria-label={t('common:todoPanelTitle')}
      data-testid="cowork-plan-strip"
      className="shrink-0 border-b border-border bg-sunken"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-full items-center gap-2 px-4 text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11"
      >
        <span className="text-[13px] font-semibold text-foreground">
          {t('common:todoPanelTitle')}
        </span>
        <span
          className="text-xs text-muted-foreground tabular-nums"
          data-testid="cowork-plan-count"
        >
          {t('results:plan.progress', { done, total: tasks.length })}
        </span>
        <span
          aria-hidden
          className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-line-strong"
        >
          <span
            className="block h-full bg-ink-2 motion-safe:transition-[width] motion-safe:duration-300"
            style={{ width: `${pct}%` }}
          />
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform',
            !open && '-rotate-90'
          )}
        />
      </button>
      {open ? (
        <ol className="max-h-40 overflow-y-auto pb-1.5">
          {tasks.map((task, index) => (
            <li
              key={`${index}-${task.content}`}
              data-status={task.status}
              aria-current={task.status === 'in_progress' ? 'step' : undefined}
              className={cn(
                'flex min-h-7 items-center gap-2 border-l-2 px-4 text-[13px]',
                task.status === 'in_progress'
                  ? 'border-brand font-medium text-foreground'
                  : 'border-transparent',
                task.status === 'pending' && 'text-ink-2',
                (task.status === 'completed' || task.status === 'abandoned') &&
                  'text-muted-foreground'
              )}
            >
              <StepMark status={task.status} />
              <span className="min-w-0 flex-1 truncate">
                {cleanTaskLabel(task.content)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
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
          status === 'in_progress' ? 'border-foreground' : 'border-line-strong'
        )}
      />
    </span>
  )
}

export default CoworkPlanStrip
