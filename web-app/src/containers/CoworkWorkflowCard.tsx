import {
  Bot,
  Check,
  OctagonAlert,
  CircleOff,
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
      className="my-2 flex flex-col gap-2 rounded-[10px] border-[0.8px] border-border bg-card px-3 py-2.5 text-[13px] motion-safe:animate-rise-in"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusIcon status={status} size="size-[15px]" />
        <p className="min-w-0 truncate font-semibold" title={workflow.title}>
          {workflow.title}
        </p>
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {t('common:tasks.progress', {
              finished: progress.finished,
              total: progress.total,
            })}
          </span>
          {progress.tokens > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {t('common:tasks.tokens', {
                  tokens: formatTokens(progress.tokens),
                })}
              </span>
            </>
          )}
        </p>
        <Button
          variant="surface"
          size="xs"
          className="shrink-0 pointer-coarse:h-11"
          onClick={() => onOpenPanel(workflow.id)}
        >
          {t('common:tasks.openPanel')}
        </Button>
      </div>
      {progress.fraction != null && (
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.finished}
          className="block h-1.5 w-full overflow-hidden rounded-full bg-track"
        >
          <span
            className={cn(
              'block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-expo',
              progress.error > 0
                ? 'bg-[linear-gradient(90deg,#ef4444,#dc2626)]'
                : 'bg-grad'
            )}
            style={{ width: `${Math.round(progress.fraction * 100)}%` }}
          />
        </span>
      )}

      {tasks.length === 0 ? (
        // A workflow exists because a dispatch happened; its children arrive a
        // moment later. Saying so beats an empty box that looks broken.
        <p className="text-xs text-muted-foreground">
          {t('common:tasks.noOutput')}
        </p>
      ) : (
        <ul className="-mx-1.5 flex flex-col">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onOpenTask(task)}
                className="flex h-[26px] w-full items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] text-fg-2 outline-none transition-colors hover:bg-hover-row focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11"
              >
                <StatusIcon status={task.status} />
                {task.kind === 'shell' ? (
                  <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate',
                    task.kind === 'shell' && 'font-mono text-xs'
                  )}
                  title={task.title}
                >
                  {task.title}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-subtle-foreground">
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

function StatusIcon({
  status,
  size = 'size-3.5',
}: {
  status: ActivityStatus
  size?: string
}) {
  const { t } = useTranslation()
  const common = cn('relative shrink-0', size)
  switch (status) {
    case 'running':
      return (
        <Loader2
          aria-label={t('common:tasks.statusRunning')}
          className={cn(common, 'motion-safe:animate-spin text-fg-2')}
        />
      )
    case 'queued':
      return (
        <Clock
          aria-label={t('common:tasks.statusQueued')}
          className={cn(common, 'text-muted-foreground')}
        />
      )
    case 'error':
      return (
        <OctagonAlert
          aria-label={t('common:tasks.statusError')}
          className={cn(common, 'text-destructive')}
        />
      )
    case 'cancelled':
      return (
        <CircleSlash
          aria-label={t('common:tasks.statusCancelled')}
          className={cn(common, 'text-muted-foreground')}
        />
      )
    case 'interrupted':
      return (
        <CircleOff
          aria-label={t('common:tasks.statusInterrupted')}
          className={cn(common, 'text-warning')}
        />
      )
    default:
      return (
        <Check
          aria-label={t('common:tasks.statusDone')}
          className={cn(common, 'text-success')}
        />
      )
  }
}

/** Compact token counts, matching how the panel shows them. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}
