import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Loader2,
  Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import {
  taskElapsedMs,
  type ActivityStatus,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'

/**
 * The workflow card shown in the conversation, at the point the work started.
 *
 * It reads the same canonical store the Background Tasks panel does — there is
 * no second copy of workflow state — so it is live by construction: what the
 * panel shows a moment after a subagent finishes, this shows too.
 *
 * Deliberately compact. It says what is happening and offers a way into the
 * full view; the panel is where the transcripts and outputs live.
 */
export function CoworkWorkflowCard({
  view,
  now,
  onOpenTask,
  onOpenPanel,
}: {
  view: WorkflowView
  /** Clock for the elapsed labels, ticked by the conversation. */
  now: number
  /** Reveal one task in the panel: open it, expand it, scroll to it. */
  onOpenTask: (task: ActivityTask) => void
  /** Open the panel on this workflow without singling out a task. */
  onOpenPanel: (workflowId: string) => void
}) {
  const { t } = useTranslation()
  const { workflow, progress, status, tasks } = view

  return (
    <div
      data-testid="workflow-card"
      className="my-2 rounded-md border bg-main-view-fg/[0.02] text-xs"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="pt-0.5">
          <StatusIcon status={status} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={workflow.title}>
            {workflow.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-main-view-fg/50">
            <span className="tabular-nums">
              {t('common:tasks.progress', {
                finished: progress.finished,
                total: progress.total,
              })}
            </span>
            {progress.tokens > 0 && (
              <span className="font-mono tabular-nums">
                {t('common:tasks.tokens', {
                  tokens: formatTokens(progress.tokens),
                })}
              </span>
            )}
          </p>
          {progress.fraction != null && (
            <span
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.finished}
              className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn(
                  'block h-full rounded-full transition-[width]',
                  progress.error > 0 ? 'bg-destructive' : 'bg-primary'
                )}
                style={{ width: `${Math.round(progress.fraction * 100)}%` }}
              />
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={() => onOpenPanel(workflow.id)}
        >
          {t('common:tasks.openPanel')}
        </Button>
      </div>

      {tasks.length === 0 ? (
        // A workflow exists because a dispatch happened; its children arrive a
        // moment later. Saying so beats an empty box that looks broken.
        <p className="border-t px-3 py-2 text-[11px] text-main-view-fg/40">
          {t('common:tasks.noOutput')}
        </p>
      ) : (
        <ul className="border-t">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onOpenTask(task)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50"
              >
                <StatusIcon status={task.status} />
                {task.kind === 'shell' ? (
                  <Terminal
                    size={11}
                    className="shrink-0 text-main-view-fg/40"
                  />
                ) : (
                  <Bot size={11} className="shrink-0 text-main-view-fg/40" />
                )}
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[11px]',
                    task.kind === 'shell' && 'font-mono'
                  )}
                  title={task.title}
                >
                  {task.title}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-main-view-fg/40">
                  {Math.round(taskElapsedMs(task, now) / 1000)}s
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: ActivityStatus }) {
  const { t } = useTranslation()
  const common = 'size-3 shrink-0'
  switch (status) {
    case 'running':
      return (
        <Loader2
          aria-label={t('common:tasks.statusRunning')}
          className={cn(common, 'animate-spin text-primary')}
        />
      )
    case 'queued':
      return (
        <Clock
          aria-label={t('common:tasks.statusQueued')}
          className={cn(common, 'text-main-view-fg/40')}
        />
      )
    case 'error':
      return (
        <CircleAlert
          aria-label={t('common:tasks.statusError')}
          className={cn(common, 'text-destructive')}
        />
      )
    case 'cancelled':
      return (
        <CircleSlash
          aria-label={t('common:tasks.statusCancelled')}
          className={cn(common, 'text-main-view-fg/40')}
        />
      )
    default:
      return (
        <CircleCheck
          aria-label={t('common:tasks.statusDone')}
          className={cn(common, 'text-main-view-fg/40')}
        />
      )
  }
}

/** Compact token counts, matching how the panel shows them. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}
