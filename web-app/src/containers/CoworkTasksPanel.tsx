import type { TeamControl } from '@/lib/coworkTeamControl'
import { useTeamControls } from '@/hooks/useTeamControls'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  ChevronDown,
  Copy,
  Loader2,
  Square,
  Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorkStatus, type WorkState } from '@/containers/StatusChip'
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
import { CacheReuseBadge } from '@/components/CacheReuseBadge'

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
  // Workflows toggled away from their default: running work opens with its
  // tasks showing, as the design lays the panel out; finished work opens
  // closed. So membership means "collapsed" for the one and "open" for the
  // other.
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(
    () => new Set()
  )
  const isOpen = useCallback(
    (view: WorkflowView) =>
      isLive(view.status) !== expandedWorkflows.has(view.workflow.id),
    [expandedWorkflows]
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
      const id = workflowOfFocus.workflow.id
      const live = isLive(workflowOfFocus.status)
      setExpandedWorkflows((current) => {
        // Open it, whichever way "open" is recorded for this workflow.
        if (live ? !current.has(id) : current.has(id)) return current
        const next = new Set(current)
        if (live) next.delete(id)
        else next.add(id)
        return next
      })
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
      expanded={isOpen(view)}
      live={isLive(view.status)}
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
          <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
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
          <p className="px-4 py-10 text-center text-xs text-muted-foreground motion-safe:animate-rise-in">
            {t('common:tasks.empty')}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
            {running.length > 0 && (
              <>
                <p className="px-3 pt-3 pb-1.5 text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
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
                        'shrink-0 text-muted-foreground transition-transform',
                        !showFinished && '-rotate-90'
                      )}
                    />
                    <span className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
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
  live,
}: {
  view: WorkflowView
  now: number
  expanded: boolean
  /** Still going: drawn as the design's bordered card over its tasks. */
  live?: boolean
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
  const agentCount = view.tasks.filter((one) => one.kind === 'agent').length
  const shellCount = view.tasks.length - agentCount

  const titles = new Map(view.tasks.map((one) => [one.id, one.title]))
  const byCall = new Map(view.tasks.map((one) => [one.callId, one.id]))
  const taskRow = (task: ActivityTask) => (
    <TaskItem
      teamControl={teamControlFor(task, byCall)}
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
      className={cn(
        !live && 'border-b border-dashed border-border last:border-b-0'
      )}
      ref={isFocus ? focusRef : undefined}
      tabIndex={isFocus ? -1 : undefined}
    >
      <div
        className={cn(
          'flex items-start',
          live &&
            'mx-3 mt-1 mb-2 overflow-hidden rounded-[10px] border-[0.8px] border-border motion-safe:animate-rise-in'
        )}
      >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover-row focus-visible:bg-hover-row"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            {live ? (
              <Loader2
                size={15}
                aria-hidden
                className="shrink-0 text-secondary-foreground motion-safe:animate-spin"
              />
            ) : null}
            <span
              className={cn(
                'min-w-0 truncate text-[13px] text-foreground',
                live ? 'font-semibold' : 'flex-1 font-medium'
              )}
              title={workflow.title}
            >
              {workflow.title}
            </span>
            <StatusIcon status={view.status} />
            {live ? <span className="flex-1" /> : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground [&>span+span]:before:mr-1 [&>span+span]:before:content-['·']">
            {/* Who is doing the work, before how far along it is: the agents
                and the commands are the rows under this header. */}
            {agentCount > 0 && (
              <span>{t('common:tasks.agentCount', { count: agentCount })}</span>
            )}
            {shellCount > 0 && (
              <span>{t('common:tasks.shellCount', { count: shellCount })}</span>
            )}
            <span className="tabular-nums">
              {t('common:tasks.progress', {
                finished: progress.finished,
                total: progress.total,
              })}
            </span>
            {progress.tokens > 0 && (
              <span className="tabular-nums">
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
            'mt-1 shrink-0 text-muted-foreground transition-transform',
            !expanded && '-rotate-90'
          )}
        />
      </button>
      {stoppable.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          disabled={stopping}
          className="mt-2 mr-2 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          aria-label={t('common:tasks.stopWorkflow', { name: workflow.title })}
          onClick={onCancelWorkflow}
        >
          {stopping ? (
            <Loader2 size={11} className="shrink-0 motion-safe:animate-spin" />
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
              <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                {t('common:tasks.phase', { name: phase.name })}
              </p>
              {tasks.map(taskRow)}
            </div>
          ))}
          {view.unphased.length > 0 && (
            <div>
              {view.phases.length > 0 && (
                <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
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
      className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-track"
    >
      {/* The design's meter: the primary gradient, red once anything failed. */}
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
  )
}

/** How each activity status is shown: the shared work state and its word. */
const STATUS: Record<ActivityStatus, { state: WorkState; label: string }> = {
  running: { state: 'running', label: 'statusRunning' },
  queued: { state: 'queued', label: 'statusQueued' },
  error: { state: 'failed', label: 'statusError' },
  cancelled: { state: 'cancelled', label: 'statusCancelled' },
  // Stopped by something other than the work or the user: worth a look.
  interrupted: { state: 'blocked', label: 'statusInterrupted' },
  done: { state: 'done', label: 'statusDone' },
}

/**
 * The row's status, as an icon and a word (Flint Graphite Studio): running spins
 * in a neutral ink, never in the accent, which means "selected".
 *
 * Labelled, not decorative: the status is the one thing a row says that its
 * title does not, so a screen reader has to be able to read it. The test ids
 * stay for the tests that assert on shape rather than wording.
 */
function StatusIcon({ status }: { status: ActivityStatus }) {
  const { t } = useTranslation()
  const known = STATUS[status] ? status : 'done'
  const { state, label } = STATUS[known]
  const text = t(`common:tasks.${label}`)
  return (
    <WorkStatus
      state={state}
      className="bg-transparent px-0"
      aria-label={text}
      data-testid={`task-status-${known}`}
    >
      {text}
    </WorkStatus>
  )
}

/** A wall-clock time, short: what a row shows for when work began and ended. */
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** The live control of the team a failed member belongs to, if it has one. */
export function teamControlFor(task: ActivityTask, byCall: Map<string, string>): TeamControl | undefined {
  if (task.status !== 'error' || !task.parentTaskId) return undefined
  const controls = useTeamControls.getState().controls
  const parent = byCall.get(task.parentTaskId) ?? task.parentTaskId
  const control = controls[parent] ?? controls[task.parentTaskId]
  return control && !control.finished ? control : undefined
}

/** A team member's own id within its team: the part of its call id after the team's. */
function memberIdOf(task: ActivityTask): string {
  const at = task.callId.lastIndexOf(':')
  return at >= 0 ? task.callId.slice(at + 1) : task.callId
}

export function TeamMemberControls({ task, control }: { task: ActivityTask; control: TeamControl }) {
  const { t } = useTranslation()
  const [replacing, setReplacing] = useState(false)
  const [brief, setBrief] = useState(task.description ?? '')
  const [agent, setAgent] = useState(task.agentName ?? '')
  const memberId = memberIdOf(task)
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 pl-5 pb-2" data-testid={`team-member-controls-${memberId}`}>
      <Button
        variant="outline"
        size="xs"
        data-testid="team-member-restart"
        onClick={() => control.request({ kind: 'restart', taskId: memberId })}
      >
        {t('common:tasks.restartMember')}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        data-testid="team-member-replace-open"
        onClick={() => setReplacing((open) => !open)}
      >
        {t('common:tasks.replaceMember')}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        data-testid="team-finish"
        onClick={() => control.request({ kind: 'finish' })}
      >
        {t('common:tasks.finishTeam')}
      </Button>
      {replacing && (
        <form
          className="flex w-full flex-col gap-1"
          data-testid="team-member-replace-form"
          onSubmit={(event) => {
            event.preventDefault()
            control.request({
              kind: 'replace',
              taskId: memberId,
              with: {
                ...(brief !== (task.description ?? '') ? { description: brief } : {}),
                ...(agent !== (task.agentName ?? '') ? { subagentName: agent } : {}),
              },
            })
            setReplacing(false)
          }}
        >
          <textarea
            aria-label={t('common:tasks.replaceBrief')}
            data-testid="team-member-replace-brief"
            className="min-h-12 rounded-lg border-[0.8px] border-input bg-card px-2 py-1 text-[11px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <input
            aria-label={t('common:tasks.replaceAgent')}
            data-testid="team-member-replace-agent"
            className="rounded-lg border-[0.8px] border-input bg-card px-2 py-1 text-[11px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          />
          <Button type="submit" size="xs" variant="outline" data-testid="team-member-replace-submit">
            {t('common:tasks.replaceSubmit')}
          </Button>
        </form>
      )}
    </div>
  )
}

function TaskItem({
  teamControl,
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
  teamControl?: TeamControl
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
      // The open row is the selected one: a neutral fill and the 2px accent
      // marker, never the accent as a fill.
      className={cn(
        'relative border-t border-dashed border-border',
        expanded &&
          'bg-accent before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-acc'
      )}
    >
      <div className="flex items-start">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 pl-6 text-left text-[12.5px] outline-none transition-colors hover:bg-hover-row focus-visible:bg-hover-row pointer-coarse:min-h-11"
        >
          {/* Status first, in a fixed column, so a list of rows reads down
              one edge: the design's task row. */}
          <span className="flex w-[84px] shrink-0">
            <StatusIcon status={task.status} />
          </span>
          {task.kind === 'shell' ? (
            <Terminal size={14} className="shrink-0 text-muted-foreground" />
          ) : (
            <Bot size={14} className="shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-medium text-foreground',
                  task.kind === 'shell' && 'font-mono text-xs font-normal'
                )}
                title={task.title}
              >
                {task.title}
              </span>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11.5px] text-muted-foreground [&>span+span]:before:mr-1 [&>span+span]:before:content-['·']">
              {/* Kind in words as well as the icon, so it is read out and
                does not rest on telling two glyphs apart. */}
              <span>
                {task.kind === 'shell'
                  ? t('common:tasks.kindShell')
                  : t('common:tasks.kindAgent')}
              </span>
              {/* Who: the subagent definition doing the work, when the row's
                title is something else (a team member's task, say). */}
              {task.kind === 'agent' &&
                task.agentName &&
                task.agentName !== task.title && (
                  <span className="truncate">{task.agentName}</span>
                )}
              {task.status === 'queued' && task.waiting != null && (
                <span>
                  {t('common:tasks.queuePosition', { position: task.waiting })}
                </span>
              )}
              <span className="tabular-nums">
                {formatCompactDuration(Math.round(ms / 1000), t)}
              </span>
              {tokens > 0 && (
                <span
                  className="tabular-nums"
                  title={usageDetail || undefined}
                  data-testid="task-token-usage"
                >
                  {t('common:tasks.tokens', { tokens: formatTokens(tokens) })}
                </span>
              )}
              {tokens > 0 && (
                <CacheReuseBadge
                  usage={fromCoworkUsage(task.usage)}
                  hideUnreported
                  testId="task-cache-status"
                />
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
                <span className="rounded-sm bg-muted px-1 font-mono text-fg-2">
                  {t('common:tasks.background', { jobId: task.jobId })}
                </span>
              )}
              {task.exitCode != null && (
                <span
                  className={cn(task.exitCode !== 0 && 'text-destructive')}
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
              'mt-1 shrink-0 text-muted-foreground transition-transform',
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
            className="mt-2 mr-2 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={t('common:tasks.stopTask', { name: task.title })}
            onClick={onCancel}
          >
            {cancelling ? (
              <Loader2 size={11} className="shrink-0 motion-safe:animate-spin" />
            ) : (
              <Square size={11} className="shrink-0" />
            )}
          </Button>
        )}
      </div>

      {teamControl && <TeamMemberControls task={task} control={teamControl} />}
      {(task.attempts ?? 0) > 0 && (
        <p className="pb-2 pl-5 text-[11px] text-muted-foreground" data-testid="team-member-attempts">
          {task.replacedWith
            ? t('common:tasks.replacedAttempts', { count: task.attempts })
            : t('common:tasks.restartedAttempts', { count: task.attempts })}
        </p>
      )}
      {expanded && (
        <div className="border-t border-dashed border-border bg-muted/40 px-3 py-2.5 pl-6 motion-safe:animate-tree-in">
          <p className="mb-2 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            <span>{t('common:tasks.startedAt', { time: clockTime(task.startedAt) })}</span>
            {task.endedAt != null && (
              <span>{t('common:tasks.finishedAt', { time: clockTime(task.endedAt) })}</span>
            )}
            {parentTitle && (
              <span>{t('common:tasks.fromTask', { name: parentTitle })}</span>
            )}
          </p>
          {task.description && (
            <p className="mb-2 text-[11px] text-fg-2">
              {task.description}
            </p>
          )}
          {task.detail && (
            <p className="mb-2 text-[11px] text-muted-foreground">
              {reasonLabel(task.detail, t)}
            </p>
          )}
          {task.transcript && task.transcript.length > 0 && (
            <>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t('common:tasks.transcript')}
              </p>
              <ol className="mb-2 space-y-1">
                {task.transcript.map((turn, i) => (
                  <li
                    key={`${task.id}-${i}`}
                    className="flex items-baseline gap-2 text-[11px]"
                  >
                    <span className="w-14 shrink-0 text-muted-foreground">
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
      <p className="text-[11px] text-muted-foreground">
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
        <span className="text-[11px] text-muted-foreground">
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
      <pre className="max-h-48 overflow-auto rounded-lg border-[0.8px] border-term-border bg-term-bg p-2.5 font-mono text-[11px] leading-[1.55] break-words whitespace-pre-wrap text-term-fg [scrollbar-width:thin]">
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
