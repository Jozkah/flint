import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { TodoList, TodoStatus } from '@/types/coworkSession'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { StatusMark, type StatusMarkState } from '@/components/ui/status-mark'
import { cleanTaskLabel } from '@/lib/todoLabels'

const TODO_MARK: Record<TodoStatus, StatusMarkState> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'done',
  abandoned: 'cancelled',
}

/** Status mark: ring that morphs between open, running, done and dropped. */
function StatusDot({ status }: { status: TodoStatus }) {
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-fg-2">
      <StatusMark status={TODO_MARK[status]} size={16} />
    </span>
  )
}

/**
 * Session todo list panel, mirroring the agent core's canonical todo tool
 * (see todo.rs) the TUI already renders as a HUD. Read-only: the model owns
 * mutations via the `todo` tool; this just projects the current snapshot.
 */
export function CoworkTodoPanel({
  todos,
  onClose,
}: {
  todos: TodoList | undefined
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const phases = todos?.phases ?? []
  const tasks = phases.flatMap((p) => p.tasks)
  const done = tasks.filter(
    (task) => task.status === 'completed' || task.status === 'abandoned'
  ).length
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0

  const togglePhase = (name: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <CoworkSidePanel
      title={t('common:todoPanelTitle')}
      summary={
        tasks.length > 0 ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {done}/{tasks.length}
          </span>
        ) : null
      }
      onClose={onClose}
    >
      <div className="flex h-full flex-col">
        {tasks.length > 0 && (
          // Thin progress bar under the header, so overall completion reads at
          // a glance without parsing the list.
          <div className="h-1 shrink-0 bg-track">
            <div
              className="h-full bg-grad motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-expo"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
          {phases.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('common:todoPanelEmpty')}</p>
          ) : (
            phases.map((phase, phaseIdx) => {
              const isCollapsed = collapsed.has(phase.name)
              const phaseDone = phase.tasks.filter(
                (task) => task.status === 'completed' || task.status === 'abandoned'
              ).length
              return (
                <section key={phase.name} className={cn(phaseIdx > 0 && 'mt-3.5')}>
                  {/* A flat single-phase list has no meaningful phase name to
                      show, so the header is skipped entirely there. */}
                  {phase.name && (
                    <button
                      type="button"
                      onClick={() => togglePhase(phase.name)}
                      className="group mb-1 flex w-full items-center gap-1 rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
                    >
                      <ChevronDown
                        size={11}
                        className={cn(
                          'shrink-0 text-muted-foreground transition-transform',
                          isCollapsed && '-rotate-90'
                        )}
                      />
                      <span className="truncate text-xs font-semibold text-fg-2">
                        {phase.name}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {phaseDone}/{phase.tasks.length}
                      </span>
                    </button>
                  )}
                  {!isCollapsed && (
                    <ul className="space-y-1">
                      {phase.tasks.map((task, i) => {
                        const resolved =
                          task.status === 'completed' || task.status === 'abandoned'
                        return (
                          <li
                            key={`${phase.name}-${i}`}
                            className="flex items-start gap-2 pl-0.5"
                          >
                            <StatusDot status={task.status} />
                            <span
                              className={cn(
                                'text-[13px] leading-5',
                                resolved && 'text-muted-foreground line-through',
                                task.status === 'in_progress' && 'font-medium'
                              )}
                            >
                              {cleanTaskLabel(task.content)}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              )
            })
          )}
        </div>
      </div>
    </CoworkSidePanel>
  )
}
