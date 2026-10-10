import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { BudgetBar } from '@/components/campaign/BudgetBar'
import { TaskCard, type TaskCardAction } from '@/components/campaign/TaskCard'
import { useCampaign, useCampaignStore } from '@/hooks/useCampaigns'
import { useCampaignSettings } from '@/hooks/useCampaignSettings'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useFileActivity } from '@/hooks/useFileActivity'
import { route } from '@/constants/routes'
import { createLiveBoardActions } from '@/lib/campaignHost'
import type { BoardActions } from '@/lib/campaignBoardActions'
import type { CampaignTask } from '@/lib/campaignModel'
import {
  BOARD_COLUMNS,
  budgetOf,
  changedFilesOf,
  groupByColumn,
  type BoardColumn,
} from '@/lib/campaignView'
import { errorText } from '@/lib/errorText'

const COLUMN_KEY: Record<BoardColumn, string> = {
  blocked: 'blocked',
  queued: 'queued',
  running: 'running',
  'needs-you': 'needsYou',
  verifying: 'verifying',
  done: 'done',
  failed: 'failed',
}

type Panel =
  | { kind: 'note'; task: CampaignTask }
  | { kind: 'handoff'; task: CampaignTask; text: string }
  | { kind: 'diff'; task: CampaignTask }
  | { kind: 'review'; command: string | null }
  | { kind: 'cancel' }
  | null

/**
 * The campaign status board: tasks in columns by state, with the budget,
 * the parallel limit and the controls (docs/CAMPAIGNS.md). The backend record
 * is the truth; the page polls it and every control goes through the same
 * commands the coordinator's tools use.
 */
export function CampaignBoard({
  campaignId,
  actions: injected,
}: {
  campaignId: string
  /** Tests pass fakes; the app builds the live ones. */
  actions?: BoardActions
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const campaign = useCampaign(campaignId)
  const loaded = useCampaignStore((s) => s.loaded)
  const maxParallel = useCampaignSettings((s) => s.maxParallel)
  const sessions = useCoworkSessions((s) => s.sessions)
  const activity = useFileActivity((s) => s.byConversation)
  const [panel, setPanel] = useState<Panel>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const actions = useMemo(
    () => injected ?? createLiveBoardActions(),
    [injected]
  )

  const columns = useMemo(
    () => groupByColumn(campaign?.tasks ?? []),
    [campaign?.tasks]
  )
  const updatedOf = (sid?: string | null) =>
    sid ? sessions.find((s) => s.id === sid)?.updated : undefined

  const run = async (work: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      const out = (await work()) as { ok?: boolean; error?: string } | undefined
      if (out && out.ok === false) {
        toast.error(t('settings:campaigns.board.error', { reason: out.error }))
      } else if (ok) {
        toast.success(ok)
      }
    } catch (e) {
      toast.error(t('settings:campaigns.board.error', { reason: errorText(e) }))
    } finally {
      setBusy(false)
      await useCampaignStore.getState().refresh()
    }
  }

  const openSession = (sid: string) => {
    useCoworkSessions.getState().selectSession(sid)
    void navigate({ to: route.cowork })
  }

  if (!campaign) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {loaded
          ? t('settings:campaigns.board.notFound')
          : t('settings:campaigns.board.loading')}
      </div>
    )
  }

  const budget = budgetOf(campaign)
  const done = campaign.tasks.filter((x) => x.status === 'merged').length
  const status = campaign.status
  const onAction = (action: TaskCardAction, task: CampaignTask) => {
    switch (action) {
      case 'open':
        if (task.sessionId) openSession(task.sessionId)
        return
      case 'note':
        setNote('')
        setPanel({ kind: 'note', task })
        return
      case 'diff':
        setPanel({ kind: 'diff', task })
        return
      case 'handoff':
        void run(async () => {
          const text = await actions.handoff(campaign.id, task.id)
          setPanel({ kind: 'handoff', task, text })
        })
        return
      case 'stop':
        void run(() => actions.stopTask(campaign.id, task.id))
        return
      case 'retry':
        void run(() => actions.retryTask(campaign.id, task.id))
        return
      case 'skip':
        void run(() => actions.skipTask(campaign.id, task.id))
        return
    }
  }

  const diffFiles =
    panel?.kind === 'diff'
      ? changedFilesOf(activity[panel.task.sessionId ?? ''])
      : []

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{campaign.title}</h1>
          <p className="text-xs text-muted-foreground" data-testid="campaign-summary">
            {t('settings:campaigns.board.progress', {
              done,
              total: campaign.tasks.length,
              status: t(`settings:campaigns.board.status.${status}`),
            })}
            {' · '}
            {t('settings:campaigns.board.parallel', { n: maxParallel })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BudgetBar budget={budget} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openSession(campaign.coordinatorSession)}
          >
            {t('settings:campaigns.board.coordinator')}
          </Button>
          {status === 'running' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => actions.pause(campaign.id))}
            >
              {t('settings:campaigns.board.action.pause')}
            </Button>
          )}
          {(status === 'paused' || status === 'interrupted') && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => actions.resume(campaign.id))}
            >
              {t('settings:campaigns.board.action.resume')}
            </Button>
          )}
          {status === 'reviewing' && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const plan = await actions.gateCommand(campaign.id)
                  setPanel({ kind: 'review', command: plan.command ?? null })
                })
              }
            >
              {t('settings:campaigns.board.action.review')}
            </Button>
          )}
          {!['done', 'failed', 'cancelled'].includes(status) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setPanel({ kind: 'cancel' })}
            >
              {t('settings:campaigns.board.action.cancel')}
            </Button>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 auto-cols-[16rem] grid-flow-col gap-3 overflow-x-auto pb-2">
        {BOARD_COLUMNS.map((col) => (
          <section
            key={col}
            data-testid={`campaign-column-${col}`}
            className="flex min-h-0 flex-col rounded-xl bg-muted/50 p-2"
          >
            <h2 className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
              <span>{t(`settings:campaigns.board.column.${COLUMN_KEY[col]}`)}</span>
              <span className="tabular-nums">{columns[col].length}</span>
            </h2>
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {columns[col].length === 0 ? (
                <li className="px-1 text-[11px] text-muted-foreground">
                  {t('settings:campaigns.board.emptyColumn')}
                </li>
              ) : (
                columns[col].map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    all={campaign.tasks}
                    files={changedFilesOf(activity[task.sessionId ?? '']).length}
                    lastActivity={updatedOf(task.sessionId)}
                    busy={busy}
                    onAction={onAction}
                  />
                ))
              )}
            </ul>
          </section>
        ))}
      </div>

      <Dialog open={panel?.kind === 'note'} onOpenChange={(o) => !o && setPanel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings:campaigns.board.note.title', {
                task: panel?.kind === 'note' ? panel.task.title : '',
              })}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t('settings:campaigns.board.action.note')}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('settings:campaigns.board.note.placeholder')}
          />
          <DialogFooter>
            <Button
              size="sm"
              disabled={busy || !note.trim()}
              onClick={() => {
                if (panel?.kind !== 'note') return
                const taskId = panel.task.id
                setPanel(null)
                void run(
                  () => actions.sendNote(campaign.id, taskId, note),
                  t('settings:campaigns.board.note.sent')
                )
              }}
            >
              {t('settings:campaigns.board.action.send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={panel?.kind === 'handoff' || panel?.kind === 'diff'}
        onOpenChange={(o) => !o && setPanel(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {panel?.kind === 'handoff'
                ? t('settings:campaigns.board.handoff.title', { task: panel.task.title })
                : panel?.kind === 'diff'
                  ? t('settings:campaigns.board.diff.title', { task: panel.task.title })
                  : ''}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {campaign.title}
            </DialogDescription>
          </DialogHeader>
          {panel?.kind === 'handoff' && (
            <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
              {panel.text || t('settings:campaigns.board.handoff.empty')}
            </pre>
          )}
          {panel?.kind === 'diff' &&
            (diffFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('settings:campaigns.board.diff.empty')}
              </p>
            ) : (
              <ul className="max-h-96 overflow-auto font-mono text-xs">
                {diffFiles.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ))}
        </DialogContent>
      </Dialog>

      <Dialog open={panel?.kind === 'review'} onOpenChange={(o) => !o && setPanel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:campaigns.board.review.title')}</DialogTitle>
            <DialogDescription>
              {t('settings:campaigns.board.review.body')}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {panel?.kind === 'review' && panel.command
              ? t('settings:campaigns.board.review.command', { command: panel.command })
              : t('settings:campaigns.board.review.noCommand')}
          </p>
          <DialogFooter>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setPanel(null)
                void run(
                  () => actions.finalize(campaign.id),
                  t('settings:campaigns.board.review.proposal')
                )
              }}
            >
              {t('settings:campaigns.board.action.review')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={panel?.kind === 'cancel'} onOpenChange={(o) => !o && setPanel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:campaigns.board.cancelConfirm.title')}</DialogTitle>
            <DialogDescription>
              {t('settings:campaigns.board.cancelConfirm.body')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                setPanel(null)
                void run(() => actions.cancel(campaign.id))
              }}
            >
              {t('settings:campaigns.board.action.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
