import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/campaign/StatusDot'
import { useTaskDiffSummary } from '@/hooks/useCampaignTaskDiff'
import { lineCounts, totalsOf } from '@/lib/campaignDiff'
import type { TaskDiff } from '@/lib/campaignApi'
import { dotOf, taskActionsOf, wordOf } from '@/lib/campaignView'
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

/**
 * One task as a plain row: what it is, what it is doing in a few words, what
 * it changed, and at most Open and Retry or Skip. Everything else (branch,
 * attempts, tokens, note, handoff, stop) sits behind "Details".
 */
export function TaskRow({
  campaignId,
  task,
  all,
  recordedFiles,
  lastActivity,
  busy,
  note,
  onAction,
  loadSummary,
}: {
  campaignId: string
  task: CampaignTask
  all: readonly CampaignTask[]
  /** Distinct files the session's tool activity recorded (fallback count). */
  recordedFiles: number
  lastActivity?: number
  busy?: boolean
  note?: 'sent' | 'delivered'
  onAction: (action: TaskRowAction, task: CampaignTask) => void
  loadSummary?: (id: string, taskId: string) => Promise<TaskDiff>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const can = taskActionsOf(task)
  const { word, waitingFor } = wordOf(task, all)
  const summary = useTaskDiffSummary(campaignId, task, loadSummary)
  const totals = summary ? totalsOf(summary) : null
  const files = totals ? totals.files : recordedFiles
  const failed = word === 'failed' || word === 'conflict'
  const detailsId = `task-details-${task.id}`
  return (
    <li
      data-testid={`campaign-task-${task.id}`}
      className="rounded-xl border-[0.8px] border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <StatusDot dot={dotOf(task, all)} />
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-medium break-words">{task.title}</p>
          <p
            className="text-xs text-muted-foreground"
            data-testid={`campaign-task-word-${task.id}`}
          >
            {word === 'waiting'
              ? t('settings:campaigns.board.word.waiting', {
                  tasks: waitingFor.join(', '),
                })
              : t(`settings:campaigns.board.word.${word}`)}
            {files > 0 && (
              <>
                <span aria-hidden> {'·'} </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAction('diff', task)}
                  className="cursor-pointer rounded-sm tabular-nums underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
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
          {failed && task.detail ? (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {task.detail}
            </p>
          ) : null}
          {note ? (
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid={`campaign-note-${task.id}`}
              data-state={note}
            >
              {t(`settings:campaigns.board.noteState.${note}`)}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {can.retry && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onAction('retry', task)}
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
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAction('open', task)}
            >
              {t('settings:campaigns.board.row.open')}
            </Button>
          )}
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
          {task.detail && !failed ? (
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
