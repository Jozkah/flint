import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleOff,
  CircleSlash,
  Clock,
  Copy,
  Loader2,
  Square,
  Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { CoworkSidePanel } from '@/containers/CoworkSidePanel'
import { formatCompactDuration } from '@/lib/duration'
import {
  INTERRUPTED_BY_RUN_END,
  cancellabilityOf,
  cancellableTasks,
  isLive,
  taskElapsedMs,
  type Cancellability,
  type ActivityProgress,
  type ActivityStatus,
  type ActivityTask,
  type WorkflowView,
} from '@/lib/coworkActivity'
import { CANCELLED_BY_USER } from '@/lib/coworkCancel'
import { INTERRUPTED_BY_RESTART } from '@/lib/hydrateStores'
import type { CoworkTurn } from '@/types/coworkSession'
import { describeTokenUsage, fromCoworkUsage } from '@/lib/tokenUsage'

/** How often running rows re-render so their elapsed time advances. A second
 * is the resolution the duration label shows, so anything finer is wasted
 * work. The interval only runs while something is actually running. */
const TICK_MS = 1000

/** Output lines kept in view. A build log can be megabytes; the tail is the
 * part that says what happened, and the rest would freeze the panel. */
const MAX_OUTPUT_LINES = 200

/** Finished workflows rendered before "show more". A long session collects
 * hundreds; rendering every row at once is what makes a panel sluggish. */
export const FINISHED_PAGE = 50

type Props = {
  /** This session's workflows, newest first, from the canonical store. */
  workflows: WorkflowView[]
  /** The same store's totals for this session. */
  totals: ActivityProgress
  /** A workflow to reveal and expand — the inline card's header target. */
  focusWorkflowId?: string | null
  /** A task to reveal and expand — the inline card's row target. */
  focusTaskId?: string | null
  onFocusHandled?: () => void
  /** Whether the run can still reach an agent task, so the Stop control is
   * offered only where pressing it would do something. */
  agentReachable?: (task: ActivityTask) => boolean
  onCancelTask: (task: ActivityTask) => Promise<void> | void
  onCancelWorkflow: (view: WorkflowView) => Promise<void> | void
  onClearFinished: () => void
  onClose: () => void
}

/**
 * Everything this session has running or has run: the workflows its runs
 * started, the phases they moved through, and each dispatched subagent or shell
 * command with its own metadata and output.
 *
 * Every row comes from the canonical activity store, which is also what the
 * inline conversation card and the activity chip read — so the three can never
 * disagree about the same work. This component adds no state of its own beyond
 * what is expanded.
 */
export function CoworkTasksPanel({
  workflows,
  totals,
  focusWorkflowId,
  focusTaskId,
  onFocusHandled,
  agentReachable,
  onCancelTask,
  onCancelWorkflow,
  onClearFinished,
  onClose,
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(
    () => new Set()
  )
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(
    () => new Set()
  )
  const focusRef = useRef<HTMLDivElement | null>(null)

  const [now, setNow] = useState(() => Date.now())
  const active = totals.running + totals.queued > 0

  // A running row's elapsed time derives from `Date.now()`, which React has no
  // reason to re-read on its own; tick only while something is running, so an
  // idle panel costs nothing.
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [active])

  // Reveal what the inline card asked for: open its workflow, open the task,
  // and scroll it into view. Done here rather than by the caller so the panel
  // stays the only thing that knows how its own rows are laid out.
  const workflowOfFocus = useMemo(() => {
    if (focusTaskId) {
      const owner = workflows.find((view) =>
        view.tasks.some((task) => task.id === focusTaskId)
      )
      if (owner) return owner
    }
    // Chosen by id, never by the title shown on screen: two runs of the same
    // question have the same title and are different workflows.
    return focusWorkflowId
      ? workflows.find((view) => view.workflow.id === focusWorkflowId)
      : undefined
  }, [focusTaskId, focusWorkflowId, workflows])

  useEffect(() => {
    if (!focusTaskId && !focusWorkflowId) return
    if (workflowOfFocus) {
      setExpandedWorkflows((current) =>
        current.has(workflowOfFocus.workflow.id)
          ? current
          : new Set(current).add(workflowOfFocus.workflow.id)
      )
      if (focusTaskId) {
        setExpandedTasks((current) =>
          current.has(focusTaskId) ? current : new Set(current).add(focusTaskId)
        )
      }
      // Scrolled and focused after the expansion has painted, so the target is
      // laid out. Focus moves too: a keyboard or screen-reader user has to end
      // up on the thing they asked to see, not back at the top of the panel.
      //
      // The request is reported handled from *inside* the frame, not beside
      // it. Clearing it synchronously batches with the expansion, so the very
      // render that first creates the target row already has no focus target —
      // the ref is never attached, and the frame finds nothing to scroll to.
      const frame = requestAnimationFrame(() => {
        focusRef.current?.scrollIntoView({ block: 'nearest' })
        focusRef.current?.focus({ preventScroll: true })
        onFocusHandled?.()
      })
      return () => cancelAnimationFrame(frame)
    }
    // Nothing to reveal — the workflow is gone, or was cleared between the
    // click and this render. Say so, or the request would never be released.
    onFocusHandled?.()
  }, [focusTaskId, focusWorkflowId, workflowOfFocus, onFocusHandled])

  // Which stop requests are in flight. A second click while one is running
  // would signal a pid the first may already have reaped, so the control is
  // disabled until the attempt settles — and re-enabled if it failed, because
  // the work is then still there to stop.
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set())
  const runCancel = useCallback(
    async (key: string, attempt: () => Promise<void> | void) => {
      setCancelling((current) => new Set(current).add(key))
      try {
        await attempt()
      } finally {
        setCancelling((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    },
    []
  )

  const toggleWorkflow = useCallback((id: string) => {
    setExpandedWorkflows((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const toggleTask = useCallback((id: string) => {
    setExpandedTasks((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Two sections, split on the same derived status everything else uses. A
  // workflow whose backgrounded command is still running stays under Running
  // even though its model turn is over, because the process is.
  const [showFinished, setShowFinished] = useState(true)
  const [finishedLimit, setFinishedLimit] = useState(FINISHED_PAGE)
  const running = workflows.filter((view) => isLive(view.status))
  const finished = workflows.filter((view) => !isLive(view.status))
  // A focused workflow is always rendered, even past the page, so "show in
  // Activity" never scrolls to nothing.
  const focusIndex = workflowOfFocus
    ? finished.findIndex((v) => v.workflow.id === workflowOfFocus.workflow.id)
    : -1
  const finishedShown = finished.slice(
    0,
    Math.max(finishedLimit, focusIndex + 1)
  )

  const section = (view: WorkflowView) => (
    <WorkflowSection
      key={view.workflow.id}
      view={view}
      now={now}
      expanded={expandedWorkflows.has(view.workflow.id)}
      onToggle={() => toggleWorkflow(view.workflow.id)}
      expandedTasks={expandedTasks}
      onToggleTask={toggleTask}
      agentReachable={agentReachable}
      cancelling={cancelling}
      onCancelTask={(task) => runCancel(task.id, () => onCancelTask(task))}
      onCancelWorkflow={() =>
        runCancel(view.workflow.id, () => onCancelWorkflow(view))
      }
      focusWorkflowId={focusTaskId ? null : (focusWorkflowId ?? null)}
      focusTaskId={focusTaskId ?? null}
      focusRef={focusRef}
    />
  )

  return (
    <CoworkSidePanel
      title={t('common:tasks.title')}
      summary={
        totals.total > 0 ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-main-view-fg/60">
            {totals.tokens > 0
              ? t('common:tasks.summary', {
                  count: totals.total,
                  tokens: formatTokens(totals.tokens),
                })
              : t('common:tasks.summaryNoTokens', { count: totals.total })}
          </span>
        ) : null
      }
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col">
        {workflows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-main-view-fg/50">
            {t('common:tasks.empty')}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {running.length > 0 && (
              <>
                <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-main-view-fg/40">
                  {t('common:tasks.running', { count: running.length })}
                </p>
                {running.map(section)}
              </>
            )}

            {finished.length > 0 && (
              <>
                <div className="flex items-center justify-between pl-1 pr-2 pt-3">
                  <button
                    type="button"
                    onClick={() => setShowFinished((v) => !v)}
                    aria-expanded={showFinished}
                    className="flex items-center gap-1 px-2 pb-1 text-left"
                  >
                    <ChevronDown
                      size={12}
                      className={cn(
                        'shrink-0 text-main-view-fg/40 transition-transform',
                        !showFinished && '-rotate-90'
                      )}
                    />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-main-view-fg/40">
                      {t('common:tasks.finished', { count: finished.length })}
                    </span>
                  </button>
                  {/* Scoped to what is finished: clearing must never touch
                    work that is still going. */}
                  <Button variant="ghost" size="xs" onClick={onClearFinished}>
                    {t('common:tasks.clearFinished')}
                  </Button>
                </div>
                {showFinished && finishedShown.map(section)}
                {showFinished && finished.length > finishedShown.length && (
                  <div className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        setFinishedLimit((n) => n + FINISHED_PAGE)
                      }
                    >
                      {t('common:tasks.showMoreFinished', {
                        count: Math.min(
                          FINISHED_PAGE,
                          finished.length - finishedShown.length
                        ),
                      })}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </CoworkSidePanel>
  )
}

function WorkflowSection({
  view,
  now,
  expanded,
  onToggle,
  expandedTasks,
  onToggleTask,
  agentReachable,
  cancelling,
  onCancelTask,
  onCancelWorkflow,
  focusWorkflowId,
  focusTaskId,
  focusRef,
}: {
  view: WorkflowView
  now: number
  expanded: boolean
  onToggle: () => void
  expandedTasks: Set<string>
  onToggleTask: (id: string) => void
  agentReachable?: (task: ActivityTask) => boolean
  cancelling: Set<string>
  onCancelTask: (task: ActivityTask) => void
  onCancelWorkflow: () => void
  focusWorkflowId: string | null
  focusTaskId: string | null
  focusRef: React.MutableRefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation()
  const { workflow, progress } = view
  // Offered only when there is something it would actually reach. A workflow
  // whose remaining children are all unreachable gets no control rather than
  // one that can only report that it did nothing.
  const stoppable = cancellableTasks(view.tasks, { agentReachable })
  const stopping = cancelling.has(workflow.id)
  const isFocus = focusWorkflowId === workflow.id

  const titles = new Map(view.tasks.map((one) => [one.id, one.title]))
  const taskRow = (task: ActivityTask) => (
    <TaskItem
      key={task.id}
      task={task}
      parentTitle={task.parentTaskId ? titles.get(task.parentTaskId) : undefined}
      now={now}
      expanded={expandedTasks.has(task.id)}
      onToggle={() => onToggleTask(task.id)}
      cancellability={cancellabilityOf(task, { agentReachable })}
      cancelling={cancelling.has(task.id)}
      onCancel={() => onCancelTask(task)}
      containerRef={focusTaskId === task.id ? focusRef : undefined}
    />
  )

  return (
    <section
      className="border-b last:border-b-0"
      ref={isFocus ? focusRef : undefined}
      tabIndex={isFocus ? -1 : undefined}
    >
      <div className="flex items-start">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left hover:bg-muted/50"
      >
        <span className="pt-0.5">
          <StatusIcon status={view.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-xs font-medium"
            title={workflow.title}
          >
            {workflow.title}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-main-view-fg/50">
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
            {workflow.model && (
              <span className="truncate">
                {t('common:tasks.model', { model: workflow.model })}
              </span>
            )}
          </span>
          <ProgressBar progress={progress} />
        </span>
        <ChevronDown
          size={12}
          className={cn(
            'mt-1 shrink-0 text-main-view-fg/40 transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </button>
      {stoppable.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          disabled={stopping}
          className="mr-2 mt-2 shrink-0"
          aria-label={t('common:tasks.stopWorkflow', { name: workflow.title })}
          onClick={onCancelWorkflow}
        >
          {stopping ? (
            <Loader2 size={11} className="shrink-0 animate-spin" />
          ) : (
            <Square size={11} className="shrink-0" />
          )}
        </Button>
      )}
      </div>

      {expanded && (
        <div className="pb-1">
          {view.phases.map(({ phase, tasks }) => (
            <div key={phase.id}>
              <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-main-view-fg/40">
                {t('common:tasks.phase', { name: phase.name })}
              </p>
              {tasks.map(taskRow)}
            </div>
          ))}
          {view.unphased.length > 0 && (
            <div>
              {view.phases.length > 0 && (
                <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-main-view-fg/40">
                  {t('common:tasks.unphased')}
                </p>
              )}
              {view.unphased.map(taskRow)}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** How far along a workflow is. Hidden with nothing to measure, rather than
 * shown empty as though no progress had been made. */
function ProgressBar({ progress }: { progress: ActivityProgress }) {
  if (progress.fraction == null) return null
  return (
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
  )
}

/**
 * The row's status, as an icon.
 *
 * Labelled, not decorative: the status is the one thing a row says that its
 * text does not, so a screen reader has to be able to read it. The test ids
 * stay for the tests that assert on shape rather than wording.
 */
function StatusIcon({ status }: { status: ActivityStatus }) {
  const { t } = useTranslation()
  const shared = 'shrink-0'
  switch (status) {
    case 'running':
      return (
        <Loader2
          size={13}
          aria-label={t('common:tasks.statusRunning')}
          className={cn(shared, 'animate-spin text-primary')}
          data-testid="task-status-running"
        />
      )
    case 'queued':
      return (
        <Clock
          size={13}
          aria-label={t('common:tasks.statusQueued')}
          className={cn(shared, 'text-main-view-fg/40')}
          data-testid="task-status-queued"
        />
      )
    case 'error':
      return (
        <CircleAlert
          size={13}
          aria-label={t('common:tasks.statusError')}
          className={cn(shared, 'text-destructive')}
          data-testid="task-status-error"
        />
      )
    case 'cancelled':
      return (
        <CircleSlash
          size={13}
          aria-label={t('common:tasks.statusCancelled')}
          className={cn(shared, 'text-main-view-fg/40')}
          data-testid="task-status-cancelled"
        />
      )
    case 'interrupted':
      return (
        <CircleOff
          size={13}
          aria-label={t('common:tasks.statusInterrupted')}
          className={cn(shared, 'text-amber-600 dark:text-amber-400')}
          data-testid="task-status-interrupted"
        />
      )
    default:
      return (
        <CircleCheck
          size={13}
          aria-label={t('common:tasks.statusDone')}
          className={cn(shared, 'text-main-view-fg/40')}
          data-testid="task-status-done"
        />
      )
  }
}

/** A wall-clock time, short: what a row shows for when work began and ended. */
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function TaskItem({
  task,
  parentTitle,
  now,
  expanded,
  onToggle,
  cancellability,
  cancelling,
  onCancel,
  containerRef,
}: {
  task: ActivityTask
  /** The task that dispatched this one, when it was nested. */
  parentTitle?: string
  now: number
  expanded: boolean
  onToggle: () => void
  cancellability: Cancellability
  cancelling: boolean
  onCancel: () => void
  containerRef?: React.MutableRefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation()
  const ms = taskElapsedMs(task, now)
  const tokens = task.usage?.total_tokens ?? 0
  // The row has room for one number; the rest, cache counts included, is on
  // hover, and says so when the provider reported none.
  const usageDetail = describeTokenUsage(fromCoworkUsage(task.usage))

  return (
    <div
      ref={containerRef}
      tabIndex={containerRef ? -1 : undefined}
      className="border-t"
    >
      <div className="flex items-start">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-2 py-2 pl-5 pr-2 text-left hover:bg-muted/50"
        >
          <span className="pt-0.5">
            <StatusIcon status={task.status} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              {task.kind === 'shell' ? (
                <Terminal size={12} className="shrink-0 text-main-view-fg/40" />
              ) : (
                <Bot size={12} className="shrink-0 text-main-view-fg/40" />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-xs',
                  task.kind === 'shell' && 'font-mono'
                )}
                title={task.title}
              >
                {task.title}
              </span>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-main-view-fg/50">
              {/* Kind in words as well as the icon, so it is read out and
                does not rest on telling two glyphs apart. */}
              <span className="uppercase tracking-wider">
                {task.kind === 'shell'
                  ? t('common:tasks.kindShell')
                  : t('common:tasks.kindAgent')}
              </span>
              {task.status === 'queued' && task.waiting != null && (
                <span>
                  {t('common:tasks.queuePosition', { position: task.waiting })}
                </span>
              )}
              <span className="font-mono tabular-nums">
                {formatCompactDuration(Math.round(ms / 1000), t)}
              </span>
              {tokens > 0 && (
                <span
                  className="font-mono tabular-nums"
                  title={usageDetail || undefined}
                  data-testid="task-token-usage"
                >
                  {t('common:tasks.tokens', { tokens: formatTokens(tokens) })}
                </span>
              )}
              {task.toolCount != null && task.toolCount > 0 && (
                <span>
                  {t('common:tasks.toolCalls', { count: task.toolCount })}
                </span>
              )}
              {task.model && (
                <span className="truncate">
                  {t('common:tasks.model', { model: task.model })}
                </span>
              )}
              {task.jobId && (
                <span className="rounded-sm bg-secondary px-1 font-mono">
                  {t('common:tasks.background', { jobId: task.jobId })}
                </span>
              )}
              {task.exitCode != null && (
                <span
                  className={cn(
                    'font-mono',
                    task.exitCode !== 0 && 'text-destructive'
                  )}
                >
                  {t('common:tasks.exitCode', { code: task.exitCode })}
                </span>
              )}
              {task.signalled && <span>{t('common:tasks.signalled')}</span>}
            </span>
            {task.cancelError && (
              <span
                role="status"
                className="mt-0.5 block text-[11px] text-destructive"
              >
                {t('common:tasks.stopFailedOnRow', { error: task.cancelError })}
              </span>
            )}
          </span>
          <ChevronDown
            size={12}
            className={cn(
              'mt-1 shrink-0 text-main-view-fg/40 transition-transform',
              !expanded && '-rotate-90'
            )}
          />
        </button>
        {/* Offered only where pressing it would reach something. A command
          still inside its tool call has no job to kill, so it gets no control
          rather than one that can only report failure. */}
        {cancellability.can && (
          <Button
            variant="ghost"
            size="xs"
            disabled={cancelling}
            className="mr-2 mt-2 shrink-0"
            aria-label={t('common:tasks.stopTask', { name: task.title })}
            onClick={onCancel}
          >
            {cancelling ? (
              <Loader2 size={11} className="shrink-0 animate-spin" />
            ) : (
              <Square size={11} className="shrink-0" />
            )}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="border-t bg-background px-3 py-2 pl-5">
          <p className="mb-2 flex flex-wrap gap-x-3 text-[11px] text-main-view-fg/50">
            <span>{t('common:tasks.startedAt', { time: clockTime(task.startedAt) })}</span>
            {task.endedAt != null && (
              <span>{t('common:tasks.finishedAt', { time: clockTime(task.endedAt) })}</span>
            )}
            {parentTitle && (
              <span>{t('common:tasks.fromTask', { name: parentTitle })}</span>
            )}
          </p>
          {task.description && (
            <p className="mb-2 text-[11px] text-main-view-fg/70">
              {task.description}
            </p>
          )}
          {task.detail && (
            <p className="mb-2 text-[11px] text-main-view-fg/50">
              {reasonLabel(task.detail, t)}
            </p>
          )}
          {task.transcript && task.transcript.length > 0 && (
            <>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-main-view-fg/40">
                {t('common:tasks.transcript')}
              </p>
              <ol className="mb-2 space-y-1">
                {task.transcript.map((turn, i) => (
                  <li
                    key={`${task.id}-${i}`}
                    className="flex items-baseline gap-2 text-[11px]"
                  >
                    <span className="w-14 shrink-0 text-main-view-fg/40">
                      {turn.role === 'tool' ? turn.name : turn.role}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate font-mono',
                        turn.isError && 'text-destructive'
                      )}
                    >
                      {turnSummary(turn)}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
          <TaskOutput task={task} />
        </div>
      )}
    </div>
  )
}

/**
 * A task's output, as text.
 *
 * Rendered into a `<pre>` and never as markup: this is whatever a shell command
 * or a model produced, and nothing here may be allowed to become elements on
 * the page. Only the tail is shown — a build log can be megabytes.
 */
function TaskOutput({ task }: { task: ActivityTask }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const output = task.output
  if (!output) {
    return (
      <p className="text-[11px] text-main-view-fg/40">
        {task.status === 'queued' || task.status === 'running'
          ? t('common:tasks.noOutput')
          : t('common:tasks.detailsUnavailable')}
      </p>
    )
  }
  const lines = output.split('\n')
  const truncated = lines.length > MAX_OUTPUT_LINES
  const shown = truncated ? lines.slice(-MAX_OUTPUT_LINES) : lines
  const copy = () => {
    // The whole kept output, not just the lines in view.
    void navigator.clipboard?.writeText(output).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => setCopied(false)
    )
  }
  return (
    <>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-main-view-fg/40">
          {task.outputTruncated && t('common:tasks.outputPartial')}{' '}
          {truncated &&
            t('common:tasks.outputTruncated', { lines: MAX_OUTPUT_LINES })}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={copy}
          aria-label={t('common:tasks.copyOutput')}
        >
          <Copy size={11} className="shrink-0" />
          <span className="sr-only" aria-live="polite">
            {copied ? t('common:tasks.copied') : ''}
          </span>
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-[11px]">
        {shown.join('\n')}
      </pre>
    </>
  )
}

/** Why a task stopped, in words, for the reasons the app records itself. */
function reasonLabel(detail: string, t: (key: string) => string): string {
  switch (detail) {
    case CANCELLED_BY_USER:
      return t('common:tasks.cancelledByUser')
    case INTERRUPTED_BY_RESTART:
      return t('common:tasks.interruptedByRestart')
    case INTERRUPTED_BY_RUN_END:
      return t('common:tasks.interruptedByRunEnd')
    default:
      return detail
  }
}

/** One transcript line, condensed: what the step was, not its full payload. */
function turnSummary(turn: CoworkTurn): string {
  if (turn.role === 'tool') {
    const args = turn.args
    if (args && typeof args === 'object') {
      const record = args as Record<string, unknown>
      const first = record.command ?? record.path ?? record.pattern
      if (typeof first === 'string') return first
    }
    return turn.result ?? turn.content ?? ''
  }
  return turn.content
}

/** Compact token counts, matching how the transcript header shows them. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}
