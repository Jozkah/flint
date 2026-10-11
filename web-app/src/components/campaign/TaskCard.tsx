import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { StatusDot } from '@/components/campaign/StatusDot'
import { dotOf, taskActionsOf } from '@/lib/campaignView'
import type { CampaignTask } from '@/lib/campaignModel'

export type TaskCardAction =
  | 'open'
  | 'note'
  | 'stop'
  | 'retry'
  | 'skip'
  | 'handoff'
  | 'diff'

/** One task on the board: title, branch, files, tokens, activity and actions. */
export function TaskCard({
  task,
  all,
  files,
  lastActivity,
  busy,
  note,
  onAction,
}: {
  task: CampaignTask
  all: readonly CampaignTask[]
  /** Distinct files the task's session changed. */
  files: number
  /** Epoch ms of the task session's last change, when known. */
  lastActivity?: number
  busy?: boolean
  /** A note sent from the board: still unread, or taken in by the run. */
  note?: 'sent' | 'delivered'
  onAction: (action: TaskCardAction, task: CampaignTask) => void
}) {
  const { t } = useTranslation()
  const can = taskActionsOf(task)
  const dot = dotOf(task, all)
  const entries: [TaskCardAction, boolean][] = [
    ['open', can.open],
    ['note', can.note],
    ['handoff', can.handoff],
    ['diff', can.open],
    ['stop', can.stop],
    ['retry', can.retry],
    ['skip', can.skip],
  ]
  return (
    <li
      data-testid={`campaign-task-${task.id}`}
      className="rounded-lg border-[0.8px] border-border bg-card p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <StatusDot dot={dot} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <p className="font-medium break-words">{task.title}</p>
          <p className="truncate text-[11px] text-muted-foreground" title={task.branch ?? ''}>
            {task.branch ?? t('settings:campaigns.board.card.noBranch')}
          </p>
        </div>
      </div>
      <p className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground tabular-nums">
        <span>{t('settings:campaigns.board.card.files', { n: files })}</span>
        <span>
          {t('settings:campaigns.board.card.tokens', { n: task.tokensUsed.toLocaleString() })}
        </span>
        {lastActivity ? (
          <span>
            {t('settings:campaigns.board.card.activity', {
              when: new Date(lastActivity).toLocaleTimeString(),
            })}
          </span>
        ) : null}
        {task.attempt > 0 && (
          <span>
            {t('settings:campaigns.board.card.attempt', { n: task.attempt + 1 })}
          </span>
        )}
      </p>
      {note ? (
        <p
          className="mt-1 text-[11px] text-muted-foreground"
          data-testid={`campaign-note-${task.id}`}
          data-state={note}
        >
          {t(`settings:campaigns.board.noteState.${note}`)}
        </p>
      ) : null}
      {task.detail && (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{task.detail}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {entries
          .filter(([, enabled]) => enabled)
          .map(([action]) => (
            <Button
              key={action}
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={busy}
              onClick={() => onAction(action, task)}
            >
              {t(`settings:campaigns.board.action.${action}`)}
            </Button>
          ))}
      </div>
    </li>
  )
}
