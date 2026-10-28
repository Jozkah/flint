import { FileText, Pencil, Search, SquareTerminal } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { shortBrief, type StepGroup } from '@/lib/campaignStory'
import { groupTextOf } from '@/lib/campaignTaskText'
import type { taskActionsOf, taskCheckOf, recoveryOf } from '@/lib/campaignView'
import type { CampaignTask } from '@/lib/campaignModel'
import { cn } from '@/lib/utils'
import type { TaskRowAction } from '@/components/campaign/TaskRow'

type OnAction = (action: TaskRowAction, task: CampaignTask, hint?: string) => void

export const MAX_GROUPS_SHOWN = 12

/** The icon in front of one step of a task's story. */
export function stepIcon(kind: StepGroup['kind'], ok: boolean) {
  const cls = cn('mt-0.5 size-3.5 shrink-0', ok ? 'text-muted-foreground' : 'text-destructive')
  if (kind === 'read') return <FileText aria-hidden className={cls} />
  if (kind === 'search') return <Search aria-hidden className={cls} />
  if (kind === 'write') return <Pencil aria-hidden className={cls} />
  return <SquareTerminal aria-hidden className={cls} />
}

type StuckProps = {
  task: CampaignTask
  reason: string | undefined
  next: string
  conflictFiles: readonly string[]
  blockedTitles: readonly string[]
  hint: string
  onHintChange: (hint: string) => void
  accepting: boolean
  onAcceptingChange: (accepting: boolean) => void
  acceptReason: string
  onAcceptReasonChange: (reason: string) => void
  can: ReturnType<typeof taskActionsOf>
  recovery: ReturnType<typeof recoveryOf>
  failed: boolean
  busy?: boolean
  onAction: OnAction
}

/** What went wrong with a stuck task and the ways out of it. */
export function TaskStuckBox({
  task,
  reason,
  next,
  conflictFiles,
  blockedTitles,
  hint,
  onHintChange,
  accepting,
  onAcceptingChange,
  acceptReason,
  onAcceptReasonChange,
  can,
  recovery,
  failed,
  busy,
  onAction,
}: StuckProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid={`campaign-stuck-${task.id}`}
      className="mt-1 flex flex-col gap-2 rounded-lg border-[0.8px] border-warning/40 bg-warning/5 p-3"
    >
      {reason ? (
        <pre
          data-testid={`campaign-error-${task.id}`}
          className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] leading-snug whitespace-pre-wrap"
        >
          {reason}
        </pre>
      ) : null}
      <p className="text-xs text-foreground">
        {t(`settings:campaigns.board.story.next.${next}`)}
      </p>
      {next === 'conflict' && (
        <div
          data-testid={`campaign-conflict-${task.id}`}
          className="flex flex-col gap-1.5"
        >
          <p className="text-xs text-muted-foreground">
            {t('settings:campaigns.board.conflict.explain')}
          </p>
          {conflictFiles.length > 0 && (
            <ul
              aria-label={t('settings:campaigns.board.conflict.files')}
              className="flex max-h-28 flex-col gap-0.5 overflow-auto rounded-md bg-muted p-2 font-mono text-[length:calc(var(--ui-font-base)*0.6875)]"
              data-testid={`campaign-conflict-files-${task.id}`}
            >
              {conflictFiles.map((f) => (
                <li key={f} className="break-all">
                  {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {blockedTitles.length > 0 && (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`campaign-blocks-${task.id}`}
        >
          {t('settings:campaigns.board.recovery.blocks', {
            tasks: blockedTitles.join(', '),
          })}
        </p>
      )}
      {(next === 'retry' || next === 'help') && (
        <Textarea
          value={hint}
          onChange={(e) => onHintChange(e.target.value)}
          rows={2}
          maxLength={1000}
          aria-label={t('settings:campaigns.board.story.hintLabel')}
          placeholder={t('settings:campaigns.board.story.hintLabel')}
          data-testid={`campaign-hint-${task.id}`}
          className="min-h-0 text-xs"
        />
      )}
      {accepting && (
        <div
          className="flex flex-col gap-1.5"
          data-testid={`campaign-accept-form-${task.id}`}
        >
          <label className="text-xs text-foreground" htmlFor={`accept-${task.id}`}>
            {t('settings:campaigns.board.recovery.acceptWhy')}
          </label>
          <input
            id={`accept-${task.id}`}
            value={acceptReason}
            maxLength={200}
            onChange={(e) => onAcceptReasonChange(e.target.value)}
            className="h-8 rounded-md border-[0.8px] border-border bg-background px-2 text-xs"
            data-testid={`campaign-accept-reason-${task.id}`}
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              disabled={busy}
              data-testid={`campaign-accept-confirm-${task.id}`}
              onClick={() => {
                onAction('accept', task, acceptReason.trim() || undefined)
                onAcceptingChange(false)
                onAcceptReasonChange('')
              }}
            >
              {t('settings:campaigns.board.recovery.acceptConfirm')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAcceptingChange(false)}
            >
              {t('common:cancel')}
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {can.resolve && next === 'conflict' && (
          <Button
            size="sm"
            disabled={busy}
            data-testid={`campaign-resolve-${task.id}`}
            onClick={() => onAction('resolve', task)}
          >
            {t('settings:campaigns.board.conflict.resolve')}
          </Button>
        )}
        {can.verify && recovery && (
          <Button
            size="sm"
            disabled={busy}
            data-testid={`campaign-verify-${task.id}`}
            onClick={() => onAction('verify', task)}
          >
            {t('settings:campaigns.board.recovery.checkAgain')}
          </Button>
        )}
        {can.accept && !accepting && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid={`campaign-accept-${task.id}`}
            onClick={() => onAcceptingChange(true)}
          >
            {t('settings:campaigns.board.recovery.accept')}
          </Button>
        )}
        {can.retry && (
          <Button
            size="sm"
            variant={next === 'retry' || next === 'help' ? 'default' : 'ghost'}
            disabled={busy}
            onClick={() => onAction('retry', task, hint.trim() || undefined)}
          >
            {t('settings:campaigns.board.action.retry')}
          </Button>
        )}
        {can.skip && (failed || recovery) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            data-testid={`campaign-skip-${task.id}`}
            onClick={() => onAction('skip', task)}
          >
            {next === 'conflict'
              ? t('settings:campaigns.board.conflict.skip')
              : t('settings:campaigns.board.action.skip')}
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
  )
}

type StoryProps = {
  id: string
  task: CampaignTask
  groups: StepGroup[]
  failedOrStuck: boolean
  /** The row's one-sentence headline for the "stopped at" line. */
  headlineText: string
}

/** The step by step story of a task, opened from its row. */
export function TaskStoryPanel({ id, task, groups, failedOrStuck, headlineText }: StoryProps) {
  const { t } = useTranslation()
  const groupText = (g: StepGroup): { main: string; sub?: string } => groupTextOf(t, g)
  return (
      <div
        id={id}
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
        {failedOrStuck && (
          <section className="flex flex-col gap-1">
            <h3 className="font-medium text-foreground">
              {t('settings:campaigns.board.story.stoppedAt')}
            </h3>
            <p className="text-muted-foreground">{headlineText}</p>
          </section>
        )}
      </div>
  )
}

type DetailsProps = {
  id: string
  task: CampaignTask
  check: ReturnType<typeof taskCheckOf>
  lastActivity?: number
  can: ReturnType<typeof taskActionsOf>
  failed: boolean
  stuck: boolean
  recovery: ReturnType<typeof recoveryOf>
  busy?: boolean
  onAction: OnAction
}

/** The numbers and rarely used actions behind a row's Details toggle. */
export function TaskDetailsPanel({
  id,
  task,
  check,
  lastActivity,
  can,
  failed,
  stuck,
  recovery,
  busy,
  onAction,
}: DetailsProps) {
  const { t } = useTranslation()
  return (
      <div
        id={id}
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
          {task.verdict ? (
            <>
              <dt className="text-muted-foreground">
                {t('settings:campaigns.board.verify.verdict')}
              </dt>
              <dd data-testid={`campaign-verdict-${task.id}`}>
                {t(`settings:campaigns.board.verify.verdicts.${task.verdict}`)}
                {check && check.passed !== null
                  ? ` · ${
                      check.passed
                        ? t('settings:campaigns.board.verify.testsPassed')
                        : t('settings:campaigns.board.verify.testsFailed')
                    }`
                  : ''}
              </dd>
            </>
          ) : null}
          {check && check.tokens !== null ? (
            <>
              <dt className="text-muted-foreground">
                {t('settings:campaigns.board.verify.tokens')}
              </dt>
              <dd className="tabular-nums" data-testid={`campaign-verify-tokens-${task.id}`}>
                {check.tokens.toLocaleString()}
              </dd>
            </>
          ) : null}
          {lastActivity ? (
            <>
              <dt className="text-muted-foreground">
                {t('settings:campaigns.board.row.lastActivity')}
              </dt>
              <dd>{new Date(lastActivity).toLocaleTimeString()}</dd>
            </>
          ) : null}
        </dl>
        {check && check.passed === false && check.tail ? (
          <pre
            data-testid={`campaign-check-tail-${task.id}`}
            className="max-h-32 overflow-auto rounded-md bg-muted p-2 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] whitespace-pre-wrap"
          >
            {t('settings:campaigns.board.verify.testsFailedTail', {
              tail: check.tail,
            })}
          </pre>
        ) : null}
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
          {can.skip && !failed && !recovery && (
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
  )
}

