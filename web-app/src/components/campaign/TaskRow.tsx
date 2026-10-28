import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Clock,
  Loader2,
} from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { useTaskDiffSummary } from '@/hooks/useCampaignTaskDiff'
import { useCampaignTaskSteps } from '@/hooks/useCampaignTaskSteps'
import { lineCounts, totalsOf } from '@/lib/campaignDiff'
import type { TaskDiff } from '@/lib/campaignApi'
import type { ToolActivityItem } from '@/lib/toolActivity'
import {
  formatDuration,
  groupSteps,
  headlineOf,
  lastFailure,
  nextStepOf,
  taskDurationMs,
  type CampaignEvent,
  type HeadlineKind,
} from '@/lib/campaignStory'
import {
  conflictFilesOf,
  isResolving,
  taskCheckOf,
  dotOf,
  groupOf,
  recoveryOf,
  taskActionsOf,
  wordOf,
} from '@/lib/campaignView'
import { RecheckNotice, StrandedNotice } from '@/components/campaign/TaskNotices'
import { TaskDetailsPanel, TaskStoryPanel, TaskStuckBox } from '@/components/campaign/TaskRowPanels'
import { NEEDS_HELP_HINT, isNeedsHelp } from '@/lib/campaignHelp'
import { headlineTextOf, wordTextOf } from '@/lib/campaignTaskText'
import type { CampaignTask } from '@/lib/campaignModel'
import { cn } from '@/lib/utils'

export type TaskRowAction =
  | 'open'
  | 'note'
  | 'stop'
  | 'retry'
  | 'skip'
  | 'handoff'
  | 'diff'
  | 'verify'
  | 'accept'
  | 'resolve'
  /** Skip this task and everything that waits on it. */
  | 'skipToo'
  /** Let this task run without the skipped task it waited for. */
  | 'runWithout'

/** The state as one icon, the same everywhere a task appears. */
function StateIcon({
  group,
  running,
  cancelled,
  label,
}: {
  group: ReturnType<typeof groupOf>
  running: boolean
  cancelled: boolean
  label: string
}) {
  const common = 'size-4 shrink-0'
  const icon =
    group === 'needs-you' ? (
      <AlertTriangle aria-hidden className={cn(common, 'text-warning')} />
    ) : group === 'working' ? (
      <Loader2
        aria-hidden
        className={cn(
          common,
          'text-info',
          running && 'motion-safe:animate-spin'
        )}
      />
    ) : group === 'up-next' ? (
      <Clock aria-hidden className={cn(common, 'text-muted-foreground')} />
    ) : cancelled ? (
      <CircleSlash aria-hidden className={cn(common, 'text-muted-foreground')} />
    ) : (
      <CheckCircle2 aria-hidden className={cn(common, 'text-success')} />
    )
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-group={group}
      className="grid size-5 shrink-0 place-items-center"
    >
      {icon}
    </span>
  )
}

/**
 * One task as a short story: what it did in a sentence, how long it took, and
 * for a stuck one the real reason with one recommended action. What happened
 * step by step and the raw numbers (branch, attempts, tokens) are folded
 * behind their own toggles.
 */
export function TaskRow({
  campaignId,
  task,
  all,
  recordedFiles,
  lastActivity,
  busy,
  note,
  events,
  now,
  defaultOpen,
  onAction,
  loadSummary,
  loadActivity,
}: {
  campaignId: string
  task: CampaignTask
  all: readonly CampaignTask[]
  /** Distinct files the session's tool activity recorded (fallback count). */
  recordedFiles: number
  lastActivity?: number
  busy?: boolean
  note?: 'sent' | 'delivered'
  /** The campaign's event log, for how long the task took. */
  events?: readonly CampaignEvent[]
  now?: number
  /** Start with the step by step story open (the wrap-up's review). */
  defaultOpen?: boolean
  onAction: (action: TaskRowAction, task: CampaignTask, hint?: string) => void
  loadSummary?: (id: string, taskId: string) => Promise<TaskDiff>
  loadActivity?: (session: string) => Promise<ToolActivityItem[]>
}) {
  const { t } = useTranslation()
  const [story, setStory] = useState(defaultOpen ?? false)
  const [open, setOpen] = useState(false)
  const needsHelp = isNeedsHelp(task)
  // A task that needs help comes with the hint that gets it past the block.
  // Derived, not seeded once: a task that turns into one needing help later
  // still gets the hint until the user types their own.
  const [typedHint, setHint] = useState<string | null>(null)
  const hint = typedHint ?? (needsHelp ? NEEDS_HELP_HINT : '')
  const [accepting, setAccepting] = useState(false)
  const [acceptReason, setAcceptReason] = useState('')
  const recovery = recoveryOf(task, all)
  const blockedTitles = (recovery?.blocks ?? [])
    .map((id) => all.find((x) => x.id === id)?.title)
    .filter((x): x is string => !!x)
  const can = taskActionsOf(task)
  const conflictFiles = conflictFilesOf(task)
  const resolving = isResolving(task)
  const check = taskCheckOf(task)
  const { word, waitingFor } = wordOf(task, all)
  const summary = useTaskDiffSummary(campaignId, task, loadSummary)
  const steps = useCampaignTaskSteps(task, loadActivity)
  const totals = summary ? totalsOf(summary) : null
  const files = totals ? totals.files : recordedFiles
  const failed = word === 'failed' || word === 'conflict'
  const detailsId = `task-details-${task.id}`
  const storyId = `task-story-${task.id}`
  const group = groupOf(task, all)
  const dot = dotOf(task, all)
  const next = nextStepOf(task, can.retry)
  const stuck = next !== null
  const failure = lastFailure(steps)
  const duration = taskDurationMs(
    events,
    task.id,
    task.status === 'running',
    now ?? Date.now()
  )

  const headline = headlineOf(task, all, {
    files,
    added: totals?.added ?? 0,
    removed: totals?.removed ?? 0,
    counted: totals !== null,
    steps,
  })
  const wordText = wordTextOf(t, word, waitingFor)
  const headlineText = (kind: HeadlineKind): string =>
    headlineTextOf(t, kind, headline.params)
  const groups = groupSteps(steps)

  const reason = recovery
    ? recovery.reason
    : needsHelp
      ? task.detail
      : failure?.error || (failed || stuck ? task.detail : '')
  const stuckBox = stuck ? (
    <TaskStuckBox
      task={task}
      reason={reason}
      next={next}
      conflictFiles={conflictFiles}
      blockedTitles={blockedTitles}
      hint={hint}
      onHintChange={setHint}
      accepting={accepting}
      onAcceptingChange={setAccepting}
      acceptReason={acceptReason}
      onAcceptReasonChange={setAcceptReason}
      can={can}
      recovery={recovery}
      failed={failed}
      busy={busy}
      onAction={onAction}
    />
  ) : null

  return (
    <li
      data-testid={`campaign-task-${task.id}`}
      data-dot={dot}
      className="rounded-xl border-[0.8px] border-border bg-card"
    >
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StateIcon
            group={group}
            running={task.status === 'running'}
            cancelled={task.status === 'cancelled'}
            label={wordText}
          />
          <p className="min-w-0 flex-1 basis-56 text-sm font-medium break-words">
            {task.title}
          </p>
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span data-testid={`campaign-task-word-${task.id}`}>{wordText}</span>
            {duration != null && (
              <span className="tabular-nums" data-testid={`campaign-task-time-${task.id}`}>
                {t(
                  task.status === 'running'
                    ? 'settings:campaigns.board.story.running'
                    : 'settings:campaigns.board.story.took',
                  { time: formatDuration(duration) }
                )}
              </span>
            )}
          </span>
        </div>
        <p
          className="pl-8 text-sm text-foreground/90"
          data-testid={`campaign-task-story-${task.id}`}
        >
          {headlineText(headline.kind)}
          {files > 0 && (
            <>
              <span aria-hidden> {'·'} </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAction('diff', task)}
                className="cursor-pointer rounded-sm text-xs text-muted-foreground tabular-nums underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('settings:campaigns.board.row.seeChanges', {
                  task: task.title,
                })}
              >
                {t('settings:campaigns.changes.files', { count: files })}
                {totals ? ` · ${lineCounts(totals.added, totals.removed)}` : ''}
              </button>
            </>
          )}
        </p>
        {!stuck && failed && task.detail ? (
          <p className="line-clamp-2 pl-8 text-xs text-muted-foreground">
            {task.detail}
          </p>
        ) : null}
        {task.manualOverride ? (
          <p
            className="pl-8 text-xs text-muted-foreground"
            data-testid={`campaign-override-${task.id}`}
          >
            {task.manualOverride.reason
              ? t('settings:campaigns.board.recovery.acceptedWhy', {
                  reason: task.manualOverride.reason,
                })
              : t('settings:campaigns.board.recovery.accepted')}
          </p>
        ) : null}
        {note ? (
          <p
            className="pl-8 text-xs text-muted-foreground"
            data-testid={`campaign-note-${task.id}`}
            data-state={note}
          >
            {t(`settings:campaigns.board.noteState.${note}`)}
          </p>
        ) : null}
        {resolving ? (
          <p
            role="status"
            data-testid={`campaign-resolving-${task.id}`}
            className="flex items-center gap-2 pl-8 text-xs text-muted-foreground"
          >
            <Loader2
              aria-hidden
              className="size-3.5 motion-safe:animate-spin"
            />
            {conflictFiles.length > 0
              ? t('settings:campaigns.board.conflict.resolvingFiles', {
                  count: conflictFiles.length,
                })
              : t('settings:campaigns.board.conflict.resolving')}
          </p>
        ) : null}
        {word === 'waitingSkipped' ? (
          <div className="pl-8">
            <StrandedNotice
              taskId={task.id}
              skipped={waitingFor}
              busy={busy}
              onSkipToo={() => onAction('skipToo', task)}
              onRunWithout={() => onAction('runWithout', task)}
            />
          </div>
        ) : null}
        {word === 'checking' && !resolving ? (
          <div className="pl-8">
            <RecheckNotice
              taskId={task.id}
              stateKey={`${task.status}:${task.verdict ?? ''}:${task.attempt}`}
              busy={busy}
              onCheckAgain={() => onAction('verify', task)}
            />
          </div>
        ) : null}
        <div className="pl-8">{stuckBox}</div>
        <div className="flex flex-wrap items-center gap-1 pl-6">
          {!stuck && can.open && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAction('open', task)}
            >
              {t('settings:campaigns.board.row.open')}
            </Button>
          )}
          {task.sessionId || task.brief ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={story}
              aria-controls={storyId}
              data-testid={`campaign-story-toggle-${task.id}`}
              onClick={() => setStory((v) => !v)}
            >
              <ChevronRight
                aria-hidden
                className={cn('size-3.5 motion-safe:transition-transform', story && 'rotate-90')}
              />
              {t('settings:campaigns.board.story.toggle')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRight
              aria-hidden
              className={cn('size-3.5 motion-safe:transition-transform', open && 'rotate-90')}
            />
            {t('settings:campaigns.board.row.details')}
          </Button>
        </div>
      </div>
      {story && (
        <TaskStoryPanel
          id={storyId}
          task={task}
          groups={groups}
          failedOrStuck={failed || stuck}
          headlineText={headlineText(headline.kind)}
        />
      )}
      {open && (
        <TaskDetailsPanel
          id={detailsId}
          task={task}
          check={check}
          lastActivity={lastActivity}
          can={can}
          failed={failed}
          stuck={stuck}
          recovery={recovery}
          busy={busy}
          onAction={onAction}
        />
      )}
    </li>
  )
}
