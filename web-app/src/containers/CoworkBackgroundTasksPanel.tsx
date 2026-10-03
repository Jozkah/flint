import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, Square, Trash2, X } from 'lucide-react'
import { TOOL_CARD_CLASS, ToolKindTile } from '@/components/ToolKindTile'
import { Button } from '@/components/ui/button'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { CoworkSubagentTranscript } from '@/containers/CoworkSubagentTranscript'
import { TaskCheckoutLink } from '@/containers/TaskCheckoutLink'
import { StatStrip } from '@/containers/SubagentStats'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { formatCompactDuration } from '@/lib/duration'
import { redactSecrets } from '@/lib/redact'
import {
  cancellabilityOf,
  isFinished,
  taskElapsedMs,
  type ActivityTask,
} from '@/lib/coworkActivity'
import { statusLine, subagentStats } from '@/lib/coworkSubagentStats'
import {
  useBackgroundTabState,
  type BackgroundSection,
} from '@/hooks/useBackgroundTabState'

const TICK_MS = 1000
/** Output lines drawn for a command; a build log can be megabytes. */
const MAX_OUTPUT_LINES = 200

type Props = {
  sessionId: string
  running: ActivityTask[]
  finished: ActivityTask[]
  /** Whether the run can still reach an agent task (same test as the Tasks panel). */
  agentReachable?: (task: ActivityTask) => boolean
  /** The Tasks panel's own stop, so there is one way to stop a task. */
  onCancelTask: (task: ActivityTask) => Promise<void> | void
  /** Hide one finished row from this list. Deletes nothing. */
  onDismiss: (task: ActivityTask) => void
  /** Hide every finished row from this list. Deletes nothing. */
  onClearFinished: () => void
  onClose: () => void
}

/**
 * Background tasks: what this session started without waiting for it —
 * subagents (a background `task`, team members, Rust-dispatched ones) and
 * commands handed to the backend as jobs.
 *
 * Reads the same records as the Tasks panel (the caller selects them from the
 * one activity store), so the two never disagree; this adds only which rows are
 * open and which sections are collapsed. A subagent row opens its transcript, a
 * command row its output.
 */
export function CoworkBackgroundTasksPanel({
  sessionId,
  running,
  finished,
  agentReachable,
  onCancelTask,
  onDismiss,
  onClearFinished,
  onClose,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const collapsed = useBackgroundTabState((s) => s.collapsed[sessionId])
  const toggleSection = useBackgroundTabState((s) => s.toggle)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [stopping, setStopping] = useState<Set<string>>(() => new Set())
  const [now, setNow] = useState(() => Date.now())
  const live = running.length > 0

  // Elapsed time on a running row is derived from the clock; tick only while
  // something is running.
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [live])

  const toggleOpen = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const stop = async (task: ActivityTask) => {
    setStopping((cur) => new Set(cur).add(task.id))
    try {
      await onCancelTask(task)
    } finally {
      setStopping((cur) => {
        const next = new Set(cur)
        next.delete(task.id)
        return next
      })
    }
  }

  const row = (task: ActivityTask) => (
    <BackgroundRow
      key={task.id}
      task={task}
      now={now}
      expanded={open.has(task.id)}
      onToggle={() => toggleOpen(task.id)}
      canStop={cancellabilityOf(task, { agentReachable }).can}
      stopping={stopping.has(task.id)}
      onStop={() => void stop(task)}
      onDismiss={() => onDismiss(task)}
    />
  )

  const section = (
    which: BackgroundSection,
    label: string,
    items: ActivityTask[],
    trailing?: React.ReactNode
  ) => {
    const isClosed = collapsed?.[which] === true
    return (
      <section aria-label={label} data-testid={`background-${which}`}>
        <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1.5">
          <button
            type="button"
            aria-expanded={!isClosed}
            onClick={() => toggleSection(sessionId, which)}
            className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
          >
            {label}
            <ChevronDown
              size={12}
              aria-hidden
              className={cn('transition-transform', isClosed && '-rotate-90')}
            />
          </button>
          {trailing}
        </div>
        {!isClosed && <div className="space-y-2 px-3 pb-2">{items.map(row)}</div>}
      </section>
    )
  }

  return (
    <CoworkSidePanel title={t('common:tasks.backgroundTitle')} onClose={onClose}>
      <div className="flex h-full min-h-0 flex-col overflow-y-auto [scrollbar-width:thin]">
        {running.length === 0 && finished.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-muted-foreground">
            {t('common:tasks.backgroundEmpty')}
          </p>
        ) : null}
        {running.length > 0 &&
          section('running', t('common:tasks.backgroundRunning'), running)}
        {finished.length > 0 &&
          section(
            'finished',
            t('common:tasks.backgroundFinished', { count: finished.length }),
            finished,
            <Button
              variant="ghost"
              size="xs"
              aria-label={t('common:tasks.backgroundClear')}
              onClick={onClearFinished}
            >
              <Trash2 size={13} aria-hidden />
            </Button>
          )}
      </div>
    </CoworkSidePanel>
  )
}

function BackgroundRow({
  task,
  now,
  expanded,
  onToggle,
  canStop,
  stopping,
  onStop,
  onDismiss,
}: {
  task: ActivityTask
  now: number
  expanded: boolean
  onToggle: () => void
  canStop: boolean
  stopping: boolean
  onStop: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const isAgent = task.kind === 'agent'
  const done = isFinished(task.status)
  const stats = subagentStats(task, now)
  const line = statusLine(task)
  const detailRef = useRef<HTMLDivElement | null>(null)

  return (
    <div
      data-testid="background-row"
      data-status={task.status}
      data-tool-kind={task.status === 'error' ? 'fail' : isAgent ? 'other' : 'bash'}
      className={cn(
        TOOL_CARD_CLASS,
        'overflow-hidden rounded-[10px] border-[0.8px] bg-card/60 py-2.5 pr-3 pl-4 transition-colors hover:bg-hover-row',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/60',
        expanded && 'bg-muted/50'
      )}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && expanded) {
          e.stopPropagation()
          onToggle()
        }
      }}
    >
      <div className="flex items-center gap-2">
        {isAgent ? <ToolKindTile name="task" icon={<Bot />} /> : <ToolKindTile name="bash" />}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-[13px] font-medium break-words text-foreground',
              !isAgent && 'font-mono text-xs font-normal'
            )}
            title={task.title}
          >
            {task.title}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-muted-foreground tabular-nums">
            <span className="rounded-md border-[0.8px] border-border px-1.5 text-foreground">
              {isAgent && task.agentName
                ? task.agentName
                : isAgent
                  ? t('common:tasks.kindAgent')
                  : t('common:tasks.kindShell')}
            </span>
            {isAgent && task.model && (
              <span className="rounded-md border-[0.8px] border-border px-1.5">{task.model}</span>
            )}
            <span data-testid="background-elapsed">
              {formatCompactDuration(Math.round(taskElapsedMs(task, now) / 1000), t)}
            </span>
            {task.exitCode != null && (
              <span className={cn(task.exitCode !== 0 && 'text-destructive')}>
                {t('common:tasks.exitCode', { code: task.exitCode })}
              </span>
            )}
          </p>
          <TaskCheckoutLink task={task} />
          {isAgent && task.status !== 'queued' && (
            <StatStrip stats={stats} testId="background-stats" className="mt-1.5" />
          )}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
            <span
              data-testid="background-status-line"
              className={cn(
                'font-medium',
                line === 'queued' && 'text-amber-600 dark:text-amber-400',
                line === 'failed' && 'text-destructive',
                line === 'cancelled' && 'text-orange-600 dark:text-orange-400',
                line === 'finished' && 'text-success',
                !['queued', 'failed', 'cancelled', 'finished'].includes(line) &&
                  'text-acc-text motion-safe:animate-pulse'
              )}
            >
              {t(`common:tasks.line.${line}`)}
            </span>
            {task.stoppedAtLimit && (
              <span className="text-destructive">
                {t('common:tasks.limitBadge')}
              </span>
            )}
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="text-[11.5px] text-primary underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              {isAgent
                ? t('common:tasks.viewTranscript')
                : t('common:tasks.viewOutput')}
            </button>
          </p>
        </div>
        {canStop && !done && (
          <Button
            variant="ghost"
            size="xs"
            disabled={stopping}
            aria-label={t('common:tasks.stopTask', { name: task.title })}
            onClick={onStop}
            className="size-8 shrink-0 self-center rounded-md bg-transparent p-0 text-destructive hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/50 pointer-coarse:size-11"
          >
            <Square size={12} aria-hidden />
          </Button>
        )}
        {done && (
          <Button
            variant="ghost"
            size="xs"
            aria-label={t('common:tasks.backgroundDismiss', { name: task.title })}
            onClick={onDismiss}
            className="size-8 shrink-0 self-center rounded-md p-0 text-muted-foreground hover:bg-hover-btn hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
          >
            <X size={12} aria-hidden />
          </Button>
        )}
      </div>
      {expanded && (
        <div ref={detailRef} className="mt-2 border-t border-dashed border-border pt-2">
          {isAgent ? (
            <CoworkSubagentTranscript task={task} onClose={onToggle} />
          ) : (
            <CommandOutput task={task} />
          )}
        </div>
      )}
    </div>
  )
}

/** A command's output: the tail, followed while it runs, never as markup. */
function CommandOutput({ task }: { task: ActivityTask }) {
  const { t } = useTranslation()
  const scroller = useRef<HTMLPreElement | null>(null)
  const running = !isFinished(task.status)
  const output = redactSecrets(task.output ?? '')
  const lines = output ? output.split('\n') : []
  const cut = lines.length > MAX_OUTPUT_LINES
  const shown = cut ? lines.slice(-MAX_OUTPUT_LINES) : lines

  useEffect(() => {
    const el = scroller.current
    if (el && running) el.scrollTop = el.scrollHeight
  }, [output, running])

  return (
    <div data-testid="background-output">
      {task.command && (
        <p className="mb-1 font-mono text-[11px] break-all text-muted-foreground">
          {redactSecrets(task.command)}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {running ? t('common:tasks.noOutput') : t('common:tasks.detailsUnavailable')}
        </p>
      ) : (
        <>
          {cut && (
            <p className="mb-1 text-[11px] text-muted-foreground">
              {t('common:tasks.outputTruncated', { lines: MAX_OUTPUT_LINES })}
            </p>
          )}
          <pre
            ref={scroller}
            tabIndex={0}
            className="max-h-48 overflow-auto rounded-lg border-[0.8px] border-term-border bg-term-bg p-2.5 font-mono text-[11px] leading-[1.55] break-words whitespace-pre-wrap text-term-fg [scrollbar-width:thin]"
          >
            {shown.join('\n')}
          </pre>
        </>
      )}
    </div>
  )
}
