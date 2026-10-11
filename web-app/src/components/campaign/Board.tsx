import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { BudgetBar } from '@/components/campaign/BudgetBar'
import { CampaignProposalPanel } from '@/components/campaign/ProposalPanel'
import { TaskRow, type TaskRowAction } from '@/components/campaign/TaskRow'
import { TaskChanges } from '@/components/campaign/TaskChanges'
import { useCampaign, useCampaignStore } from '@/hooks/useCampaigns'
import { useCampaignSettings } from '@/hooks/useCampaignSettings'
import { useCampaignResumed } from '@/hooks/useCampaignResumed'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useFileActivity } from '@/hooks/useFileActivity'
import { route } from '@/constants/routes'
import { checkNoteDelivery, createLiveBoardActions } from '@/lib/campaignHost'
import { noteKey, useCampaignNotes } from '@/lib/campaignNotes'
import { campaignApi, type TaskDiff } from '@/lib/campaignApi'
import type { BoardActions } from '@/lib/campaignBoardActions'
import type { CampaignTask } from '@/lib/campaignModel'
import {
  budgetOf,
  canCancel,
  changedFilesOf,
  groupTasks,
  headlineOf,
  primaryActionOf,
  type TaskGroup,
} from '@/lib/campaignView'
import { errorText } from '@/lib/errorText'

const GROUP_KEY: Record<TaskGroup, string> = {
  'needs-you': 'needsYou',
  working: 'working',
  'up-next': 'upNext',
  done: 'done',
}

type Panel =
  | { kind: 'note'; task: CampaignTask }
  | { kind: 'handoff'; task: CampaignTask; text: string }
  | { kind: 'diff'; task: CampaignTask }
  | { kind: 'review'; command: string | null }
  | { kind: 'cancel' }
  | null

/**
 * The campaign board: one plain sentence about where the campaign stands, a
 * progress bar, the one button that fits, and the tasks in four groups that
 * only show when they hold something (docs/CAMPAIGNS.md). The backend record
 * is the truth; the page polls it and every control goes through the same
 * commands the coordinator's tools use.
 */
export function CampaignBoard({
  campaignId,
  actions: injected,
  loadDiff,
  loadSummary,
}: {
  campaignId: string
  /** Tests pass fakes; the app builds the live ones. */
  actions?: BoardActions
  /** What a task changed, with patches (the changes panel). */
  loadDiff?: (id: string, taskId: string) => Promise<TaskDiff>
  /** What a task changed, counts only (a row's summary). */
  loadSummary?: (id: string, taskId: string) => Promise<TaskDiff>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const campaign = useCampaign(campaignId)
  const loaded = useCampaignStore((s) => s.loaded)
  const maxParallel = useCampaignSettings((s) => s.maxParallel)
  const sessions = useCoworkSessions((s) => s.sessions)
  const activity = useFileActivity((s) => s.byConversation)
  const resumed = useCampaignResumed((s) => s.byCampaign[campaignId])
  const notes = useCampaignNotes((s) => s.notes)
  const waitingNotes = Object.entries(notes).some(
    ([k, n]) => k.startsWith(`${campaignId}/`) && n.state === 'sent'
  )
  // A sent note shows "delivered" once the run has taken it in.
  useEffect(() => {
    if (!waitingNotes) return
    const timer = setInterval(() => void checkNoteDelivery(), 2_000)
    return () => clearInterval(timer)
  }, [waitingNotes])
  const [panel, setPanel] = useState<Panel>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const actions = useMemo(
    () => injected ?? createLiveBoardActions(),
    [injected]
  )

  const groups = useMemo(
    () => groupTasks(campaign?.tasks ?? []),
    [campaign?.tasks]
  )
  const [detailsOpen, setDetailsOpen] = useState(false)
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
  const status = campaign.status
  const onAction = (action: TaskRowAction, task: CampaignTask) => {
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

  const headline = headlineOf(campaign)
  const primary = primaryActionOf(campaign)
  const percent =
    headline.total > 0 ? Math.round((headline.done / headline.total) * 100) : 0
  const primaryButton = (() => {
    switch (primary) {
      case 'pause':
        return {
          label: t('settings:campaigns.board.action.pause'),
          run: () => void run(() => actions.pause(campaign.id)),
          variant: 'outline' as const,
        }
      case 'resume':
        return {
          label: t('settings:campaigns.board.action.resume'),
          run: () => void run(() => actions.resume(campaign.id)),
          variant: 'default' as const,
        }
      case 'review':
        return {
          label: t('settings:campaigns.board.action.reviewChanges'),
          run: () =>
            void run(async () => {
              const plan = await actions.gateCommand(campaign.id)
              setPanel({ kind: 'review', command: plan.command ?? null })
            }),
          variant: 'default' as const,
        }
      default:
        return {
          label: t('settings:campaigns.board.action.openCoordinator'),
          run: () => openSession(campaign.coordinatorSession),
          variant: 'outline' as const,
        }
    }
  })()
  const menuHasPause = status === 'running' && primary !== 'pause'
  const menuHasCoordinator = primary !== 'coordinator'
  const menuHasCancel = canCancel(status)
  const changesTask = panel?.kind === 'diff' ? panel.task : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-medium">{campaign.title}</h1>
            <p
              className="mt-1 text-sm text-muted-foreground"
              data-testid="campaign-headline"
              role="status"
            >
              {t(`settings:campaigns.board.headline.${headline.key}`, {
                count: headline.count,
                done: headline.done,
                total: headline.total,
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={primaryButton.variant}
              size="sm"
              disabled={busy}
              data-testid="campaign-primary"
              onClick={primaryButton.run}
            >
              {primaryButton.label}
            </Button>
            {(menuHasPause || menuHasCoordinator || menuHasCancel) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('common:more')}
                    data-testid="campaign-menu"
                  >
                    <MoreHorizontal aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {menuHasCoordinator && (
                    <DropdownMenuItem
                      onSelect={() => openSession(campaign.coordinatorSession)}
                    >
                      {t('settings:campaigns.board.action.openCoordinator')}
                    </DropdownMenuItem>
                  )}
                  {menuHasPause && (
                    <DropdownMenuItem
                      disabled={busy}
                      onSelect={() => void run(() => actions.pause(campaign.id))}
                    >
                      {t('settings:campaigns.board.action.pause')}
                    </DropdownMenuItem>
                  )}
                  {menuHasCancel && (
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={busy}
                      onSelect={() => setPanel({ kind: 'cancel' })}
                    >
                      {t('settings:campaigns.board.action.cancel')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {headline.total > 0 && (
          <Progress
            value={percent}
            aria-label={t('settings:campaigns.board.progressLabel', {
              done: headline.done,
              total: headline.total,
            })}
            data-testid="campaign-progress"
          />
        )}
      </header>

      {resumed && resumed.length > 0 ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-xs"
          role="status"
          data-testid="campaign-resumed"
        >
          <span>
            {t('settings:campaigns.board.resumed', { n: resumed.length })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useCampaignResumed.getState().dismiss(campaignId)}
          >
            {t('settings:campaigns.board.action.close')}
          </Button>
        </div>
      ) : null}

      {(status === 'merging' || status === 'reviewing') && campaign.proposalId ? (
        <CampaignProposalPanel campaign={campaign} />
      ) : null}

      {campaign.tasks.length === 0 ? (
        <p
          className="rounded-xl border-[0.8px] border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
          data-testid="campaign-empty"
        >
          {t('settings:campaigns.board.planning')}
        </p>
      ) : (
        groups.map(({ group, tasks }) => (
          <section
            key={group}
            aria-labelledby={`campaign-group-title-${group}`}
            data-testid={`campaign-section-${group}`}
            className="flex flex-col gap-2"
          >
            <h2
              id={`campaign-group-title-${group}`}
              className="text-sm text-muted-foreground"
            >
              {t(`settings:campaigns.board.group.${GROUP_KEY[group]}`)}
              <span className="ml-2 tabular-nums">{tasks.length}</span>
            </h2>
            <ul className="flex flex-col gap-2">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  campaignId={campaign.id}
                  task={task}
                  all={campaign.tasks}
                  recordedFiles={
                    changedFilesOf(activity[task.sessionId ?? '']).length
                  }
                  lastActivity={updatedOf(task.sessionId)}
                  busy={busy}
                  note={notes[noteKey(campaign.id, task.id)]?.state}
                  onAction={onAction}
                  loadSummary={loadSummary}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      <section className="flex flex-col gap-2" aria-label={t('settings:campaigns.board.details')}>
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((v) => !v)}
          className="flex w-fit cursor-pointer items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={`size-3.5 transition-transform ${detailsOpen ? 'rotate-90' : ''}`}
          />
          {t('settings:campaigns.board.details')}
        </button>
        {detailsOpen && (
          <div
            className="flex flex-col gap-3 rounded-xl border-[0.8px] border-border p-4 text-xs"
            data-testid="campaign-details"
          >
            <BudgetBar budget={budget} />
            <p className="text-muted-foreground">
              {t('settings:campaigns.board.parallel', { n: maxParallel })}
            </p>
            <p className="text-muted-foreground">
              {t('settings:campaigns.board.detailBranch', {
                branch: campaign.integrationBranch || campaign.baseBranch,
              })}
            </p>
          </div>
        )}
      </section>

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
        open={panel?.kind === 'handoff'}
        onOpenChange={(o) => !o && setPanel(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {panel?.kind === 'handoff'
                ? t('settings:campaigns.board.handoff.title', { task: panel.task.title })
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
        </DialogContent>
      </Dialog>

      <Dialog
        open={panel?.kind === 'diff'}
        onOpenChange={(o) => !o && setPanel(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {changesTask
                ? t('settings:campaigns.board.diff.title', { task: changesTask.title })
                : ''}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {campaign.title}
            </DialogDescription>
          </DialogHeader>
          {changesTask && (
            <ChangesBody
              campaignId={campaign.id}
              taskId={changesTask.id}
              recorded={changedFilesOf(activity[changesTask.sessionId ?? ''])}
              loadDiff={loadDiff}
            />
          )}
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

/** Binds the changes panel to one task so its loader stays stable across polls. */
function ChangesBody({
  campaignId,
  taskId,
  recorded,
  loadDiff,
}: {
  campaignId: string
  taskId: string
  recorded: readonly string[]
  loadDiff?: (id: string, taskId: string) => Promise<TaskDiff>
}) {
  const load = useCallback(
    () =>
      (loadDiff ?? ((id, tid) => campaignApi.taskDiff(id, tid, true)))(
        campaignId,
        taskId
      ),
    [loadDiff, campaignId, taskId]
  )
  return <TaskChanges load={load} recordedFiles={recorded} />
}
