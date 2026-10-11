import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Clock,
  FileText,
  Loader2,
  Search,
  SquareTerminal,
  Pencil,
} from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
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
  shortBrief,
  taskDurationMs,
  type CampaignEvent,
  type HeadlineKind,
  type StepGroup,
} from '@/lib/campaignStory'
import { dotOf, groupOf, taskActionsOf, wordOf } from '@/lib/campaignView'
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

const MAX_GROUPS_SHOWN = 12

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
  const [hint, setHint] = useState('')
  const can = taskActionsOf(task)
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
  const wordText =
    word === 'waiting'
      ? t('settings:campaigns.board.word.waiting', { tasks: waitingFor.join(', ') })
      : t(`settings:campaigns.board.word.${word}`)

  const stopClause = (failures: number) =>
    failures <= 0
      ? t('settings:campaigns.board.story.stop.none')
      : failures === 1
        ? t('settings:campaigns.board.story.stop.one')
        : t('settings:campaigns.board.story.stop.many', { count: failures })
  const wroteText = () =>
    t(
      `settings:campaigns.board.story.${
        headline.params.counted ? 'wrote' : 'wroteUncounted'
      }`,
      {
        count: headline.params.count,
        added: headline.params.added,
        removed: headline.params.removed,
      }
    )
  const headlineText = (kind: HeadlineKind): string => {
    switch (kind) {
      case 'wrote':
        return wroteText()
      case 'wroteStopped':
        return `${wroteText()}. ${stopClause(headline.params.failures)}`
      case 'stoppedFailing':
        return `${t('settings:campaigns.board.story.headline.noOutput')} ${stopClause(headline.params.failures)}`
      case 'working':
        return t('settings:campaigns.board.story.headline.working', {
          count: headline.params.steps,
        })
      case 'waiting':
        return t('settings:campaigns.board.story.headline.waiting', {
          tasks: headline.params.tasks,
        })
      default:
        return t(`settings:campaigns.board.story.headline.${kind}`)
    }
  }

  const groups = groupSteps(steps)
  const groupText = (g: StepGroup): { main: string; sub?: string } => {
    const first = g.steps[0]
    const n = g.steps.length
    const names = g.steps.map((s) => s.label)
    const sub =
      n > 1
        ? names.slice(0, 3).join(', ') + (n > 3 ? `, +${n - 3}` : '')
        : undefined
    switch (g.kind) {
      case 'read':
        return n > 1
          ? { main: t('settings:campaigns.board.story.step.readMany', { count: n }), sub }
          : { main: t('settings:campaigns.board.story.step.read', { label: first.label }) }
      case 'search':
        return { main: t('settings:campaigns.board.story.step.search', { count: n }) }
      case 'write':
        return n > 1
          ? { main: t('settings:campaigns.board.story.step.writeMany', { count: n }), sub }
          : { main: t('settings:campaigns.board.story.step.write', { label: first.label }) }
      default:
        return g.ok
          ? { main: t('settings:campaigns.board.story.step.ran', { label: first.label }) }
          : { main: t('settings:campaigns.board.story.step.ranFailed', { label: first.label }) }
    }
  }
  const stepIcon = (kind: StepGroup['kind'], ok: boolean) => {
    const cls = cn('mt-0.5 size-3.5 shrink-0', ok ? 'text-muted-foreground' : 'text-destructive')
    if (kind === 'read') return <FileText aria-hidden className={cls} />
    if (kind === 'search') return <Search aria-hidden className={cls} />
    if (kind === 'write') return <Pencil aria-hidden className={cls} />
    return <SquareTerminal aria-hidden className={cls} />
  }

  const reason = failure?.error || (failed || stuck ? task.detail : '')
  const stuckBox = stuck ? (
    <div
      data-testid={`campaign-stuck-${task.id}`}
      className="mt-1 flex flex-col gap-2 rounded-lg border-[0.8px] border-warning/40 bg-warning/5 p-3"
    >
      {reason ? (
        <pre
          data-testid={`campaign-error-${task.id}`}
          className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap"
        >
          {reason}
        </pre>
      ) : null}
      <p className="text-xs text-foreground">
        {t(`settings:campaigns.board.story.next.${next}`)}
      </p>
      {next === 'retry' && (
        <Textarea
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          rows={2}
          maxLength={1000}
          aria-label={t('settings:campaigns.board.story.hintLabel')}
          placeholder={t('settings:campaigns.board.story.hintLabel')}
          data-testid={`campaign-hint-${task.id}`}
          className="min-h-0 text-xs"
        />
      )}
      <div className="flex flex-wrap items-center gap-1">
        {can.retry && (
          <Button
            size="sm"
            variant={next === 'retry' ? 'default' : 'ghost'}
            disabled={busy}
            onClick={() => onAction('retry', task, hint.trim() || undefined)}
          >
            {t('settings:campaigns.board.action.retry')}
          </Button>
        )}
        {can.skip && failed && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onAction('skip', task)}
          >
            {t('settings:campaigns.board.action.skip')}
          </Button>
        )}
        {can.open && (
          <Button
            variant={next === 'retry' ? 'outline' : 'default'}
            size="sm"
            disabled={busy}
            onClick={() => onAction('open', task)}
          >
            {t('settings:campaigns.board.story.openConversation')}
          </Button>
        )}
      </div>
    </div>
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
        {note ? (
          <p
            className="pl-8 text-xs text-muted-foreground"
            data-testid={`campaign-note-${task.id}`}
            data-state={note}
          >
            {t(`settings:campaigns.board.noteState.${note}`)}
          </p>
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
                className={cn('size-3.5 transition-transform', story && 'rotate-90')}
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
              className={cn('size-3.5 transition-transform', open && 'rotate-90')}
            />
            {t('settings:campaigns.board.row.details')}
          </Button>
        </div>
      </div>
      {story && (
        <div
          id={storyId}
          data-testid={`campaign-story-${task.id}`}
          className="flex flex-col gap-3 border-t-[0.8px] border-border px-4 py-3 text-xs"
        >
          {task.brief ? (
            <section className="flex flex-col gap-1">
              <h3 className="font-medium text-foreground">
                {t('settings:campaigns.board.story.asked')}
              </h3>
              <p className="text-muted-foreground">{shortBrief(task.brief)}</p>
            </section>
          ) : null}
          <section className="flex flex-col gap-1">
            <h3 className="font-medium text-foreground">
              {t('settings:campaigns.board.story.did')}
            </h3>
            {groups.length === 0 ? (
              <p className="text-muted-foreground">
                {t('settings:campaigns.board.story.noRecord')}
              </p>
            ) : (
              <ol className="flex flex-col gap-1.5">
                {groups.slice(0, MAX_GROUPS_SHOWN).map((g, i) => {
                  const text = groupText(g)
                  return (
                    <li key={i} className="flex items-start gap-2">
                      {stepIcon(g.kind, g.ok)}
                      <span className="min-w-0 flex-1">
                        <span className="break-words text-foreground/90">
                          {text.main}
                        </span>
                        {text.sub ? (
                          <span className="block truncate text-muted-foreground">
                            {text.sub}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  )
                })}
                {groups.length > MAX_GROUPS_SHOWN && (
                  <li className="pl-5 text-muted-foreground">
                    {t('settings:campaigns.board.story.more', {
                      count: groups.length - MAX_GROUPS_SHOWN,
                    })}
                  </li>
                )}
              </ol>
            )}
          </section>
          {(failed || stuck) && (
            <section className="flex flex-col gap-1">
              <h3 className="font-medium text-foreground">
                {t('settings:campaigns.board.story.stoppedAt')}
              </h3>
              <p className="text-muted-foreground">{headlineText(headline.kind)}</p>
            </section>
          )}
        </div>
      )}
      {open && (
        <div
          id={detailsId}
          className="flex flex-col gap-3 border-t-[0.8px] border-border px-4 py-3 text-xs"
        >
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">
              {t('settings:campaigns.board.card.branch')}
            </dt>
            <dd className="min-w-0 truncate font-mono">
              {task.branch ?? t('settings:campaigns.board.card.noBranch')}
            </dd>
            <dt className="text-muted-foreground">
              {t('settings:campaigns.board.row.attempts')}
            </dt>
            <dd className="tabular-nums">{task.attempt + 1}</dd>
            <dt className="text-muted-foreground">
              {t('settings:campaigns.board.row.tokens')}
            </dt>
            <dd className="tabular-nums">{task.tokensUsed.toLocaleString()}</dd>
            {lastActivity ? (
              <>
                <dt className="text-muted-foreground">
                  {t('settings:campaigns.board.row.lastActivity')}
                </dt>
                <dd>{new Date(lastActivity).toLocaleTimeString()}</dd>
              </>
            ) : null}
          </dl>
          {task.detail && !failed && !stuck ? (
            <p className="text-muted-foreground">{task.detail}</p>
          ) : null}
          <div className="flex flex-wrap gap-1">
            {can.note && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onAction('note', task)}
              >
                {t('settings:campaigns.board.action.note')}
              </Button>
            )}
            {can.handoff && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onAction('handoff', task)}
              >
                {t('settings:campaigns.board.action.handoff')}
              </Button>
            )}
            {can.skip && !failed && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onAction('skip', task)}
              >
                {t('settings:campaigns.board.action.skip')}
              </Button>
            )}
            {can.stop && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onAction('stop', task)}
              >
                {t('settings:campaigns.board.action.stop')}
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
