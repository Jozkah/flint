import { useCallback, useEffect, useMemo, useState } from 'react'
import { MoreHorizontal, Workflow } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
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
import {
  CampaignSummary,
  WrapUp,
  type ChangeTotals,
} from '@/components/campaign/CampaignSummary'
import { CampaignProposalPanel } from '@/components/campaign/ProposalPanel'
import { ServerPlanApproval } from '@/components/campaign/ServerPlanApproval'
import { GateBanner } from '@/components/campaign/GateBanner'
import { useRemoteRunner } from '@/lib/remoteRunner'
import { TaskRow, type TaskRowAction } from '@/components/campaign/TaskRow'
import { TaskChanges } from '@/components/campaign/TaskChanges'
import { useCampaign, useCampaignStore } from '@/hooks/useCampaigns'
import { useCampaignResumed } from '@/hooks/useCampaignResumed'
import { useStalledTasks } from '@/hooks/useStalledTasks'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useFileActivity } from '@/hooks/useFileActivity'
import { route } from '@/constants/routes'
import { checkNoteDelivery, createLiveBoardActions } from '@/lib/campaignHost'
import { noteKey, useCampaignNotes } from '@/lib/campaignNotes'
import { campaignApi, type TaskDiff } from '@/lib/campaignApi'
import { effortPercent, type CampaignEvent } from '@/lib/campaignStory'
import { hasWork } from '@/hooks/useCampaignTaskDiff'
import { mergeTaskDiffs } from '@/lib/campaignDiff'
import type { ToolActivityItem } from '@/lib/toolActivity'
import type { BoardActions } from '@/lib/campaignBoardActions'
import { isServerDriven, type CampaignTask } from '@/lib/campaignModel'
import {
  allTasksSettled,
  canCancel,
  changedFilesOf,
  dependantsOf,
  gateFailedOf,
  groupTasks,
  headlineOf,
  primaryActionOf,
  skippedDepsOf,
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
  | { kind: 'changes'; gateFailed?: boolean }
  | { kind: 'skipConfirm'; task: CampaignTask; count: number }
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
  loadCampaignDiff,
  loadSummary,
  loadEvents,
  loadActivity,
}: {
  campaignId: string
  /** Tests pass fakes; the app builds the live ones. */
  actions?: BoardActions
  /** What a task changed, with patches (the changes panel). */
  loadDiff?: (id: string, taskId: string) => Promise<TaskDiff>
  /** What the whole campaign changed, with patches (the review panel). */
  loadCampaignDiff?: (id: string) => Promise<TaskDiff>
  /** What a task changed, counts only (a row's summary). */
  loadSummary?: (id: string, taskId: string) => Promise<TaskDiff>
  /** The campaign's event log (when each task ran). */
  loadEvents?: (id: string) => Promise<CampaignEvent[]>
  /** A task session's recorded tool activity (what it did). */
  loadActivity?: (session: string) => Promise<ToolActivityItem[]>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const campaign = useCampaign(campaignId)
  const remote = useRemoteRunner()
  const loaded = useCampaignStore((s) => s.loaded)
  const loadError = useCampaignStore((s) => s.error)
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
  const stalled = useStalledTasks(
    campaign?.tasks ?? [],
    !!campaign && !isServerDriven(campaign)
  )
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
  // The event log says how long each task took; it is read again whenever
  // the campaign record moves.
  const [events, setEvents] = useState<CampaignEvent[]>([])
  const updatedAt = campaign?.updatedAt
  useEffect(() => {
    let alive = true
    ;(loadEvents ?? campaignApi.events)(campaignId).then(
      (rows) => alive && setEvents(rows),
      () => alive && setEvents([])
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, updatedAt])
  // Files and lines changed across the campaign, for the wrap-up and the
  // summary: asked once the work is over or waiting for review.
  const [totals, setTotals] = useState<ChangeTotals | null>(null)
  const over = campaign
    ? ['done', 'reviewing', 'merging'].includes(campaign.status)
    : false
  useEffect(() => {
    if (!campaign || !over) {
      setTotals(null)
      return
    }
    let alive = true
    const load = loadSummary ?? ((id, tid) => campaignApi.taskDiff(id, tid, false))
    Promise.all(
      campaign.tasks
        .filter((x) => hasWork(x))
        .map((x) => load(campaign.id, x.id).catch(() => null))
    ).then((rows) => {
      if (!alive) return
      const known = rows.filter((d): d is TaskDiff => d !== null)
      setTotals({
        files: known.reduce((n, d) => n + d.files.length, 0),
        added: known.reduce((n, d) => n + d.added, 0),
        removed: known.reduce((n, d) => n + d.removed, 0),
      })
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.id, over, updatedAt])
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
    if (!loaded) {
      return (
        <div
          role="status"
          aria-busy="true"
          aria-label={t('settings:campaigns.board.loading')}
          data-testid="campaign-loading"
          className="flex flex-col gap-4 p-6"
        >
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      )
    }
    return (
      <div
        role={loadError ? 'alert' : undefined}
        className="flex flex-col items-start gap-2 p-6 text-sm text-muted-foreground"
      >
        <p>
          {loadError
            ? t('settings:campaigns.list.loadFailed')
            : t('settings:campaigns.board.notFound')}
        </p>
        {loadError && (
          <Button
            size="sm"
            variant="outline"
            data-testid="campaign-retry"
            onClick={() => void useCampaignStore.getState().refresh()}
          >
            {t('settings:campaigns.list.retry')}
          </Button>
        )}
        {!loadError && (
          <Button
            size="sm"
            variant="outline"
            data-testid="campaign-back"
            onClick={() => void navigate({ to: route.campaigns })}
          >
            {t('settings:campaigns.title')}
          </Button>
        )}
      </div>
    )
  }

  const status = campaign.status
  const onAction = (
    action: TaskRowAction,
    task: CampaignTask,
    hint?: string
  ) => {
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
        void run(() => actions.retryTask(campaign.id, task.id, hint))
        return
      case 'skip': {
        // Tasks waiting on it would be left stranded: ask what to do with them.
        const waiting = dependantsOf(task.id, campaign.tasks)
        if (waiting.length > 0) {
          setPanel({ kind: 'skipConfirm', task, count: waiting.length })
          return
        }
        void run(() => actions.skipTask(campaign.id, task.id))
        return
      }
      case 'skipToo':
        void run(() => actions.skipCascade(campaign.id, task.id))
        return
      case 'runWithout':
        void run(async () => {
          for (const dep of skippedDepsOf(task, campaign.tasks)) {
            const out = await actions.releaseDependants(campaign.id, dep.id)
            if (!out.ok) return out
          }
          return { ok: true as const }
        })
        return
      case 'verify':
        void run(() => actions.verifyAgain(campaign.id, task.id))
        return
      case 'resolve':
        void run(() => actions.resolveConflict(campaign.id, task.id))
        return
      case 'accept':
        void run(() =>
          actions.acceptAnyway(campaign.id, task.id, 'you', hint)
        )
        return
    }
  }

  const headline = headlineOf(campaign)
  const primary = primaryActionOf(campaign)
  const gateFailed = gateFailedOf(campaign) && status === 'reviewing'
  // A failed final check is never "almost done": the bar stops short of full.
  const percent = gateFailed
    ? Math.min(effortPercent(campaign.tasks), 90)
    : effortPercent(campaign.tasks)
  const wrapUp =
    !gateFailed &&
    campaign.tasks.length > 0 &&
    (status === 'done' ||
      status === 'reviewing' ||
      ((status === 'running' || status === 'approved') &&
        allTasksSettled(campaign)))
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
  // A server-driven campaign has no coordinator session to open.
  const serverDriven = isServerDriven(campaign)
  const menuHasCoordinator = primary !== 'coordinator' && !serverDriven
  const menuHasCancel = canCancel(status)
  const changesTask = panel?.kind === 'diff' ? panel.task : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-lg font-medium">
              <Workflow aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{campaign.title}</span>
            </h1>
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
            {!(serverDriven && primary === 'coordinator') && !gateFailed && (
              <Button
                variant={primaryButton.variant}
                size="sm"
                disabled={busy}
                data-testid="campaign-primary"
                onClick={primaryButton.run}
              >
                {primaryButton.label}
              </Button>
            )}
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
          <div className="flex flex-col gap-1">
            <Progress
              value={percent}
              aria-label={t('settings:campaigns.board.progressLabel', {
                done: headline.done,
                total: headline.total,
              })}
              data-testid="campaign-progress"
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              {t(
                headline.skipped > 0
                  ? 'settings:campaigns.board.progressLabelSkipped'
                  : 'settings:campaigns.board.progressLabel',
                {
                  done: headline.done,
                  skipped: headline.skipped,
                  total: headline.total,
                }
              )}
              {' · '}
              {gateFailed
                ? t('settings:campaigns.board.effortGateFailed')
                : t('settings:campaigns.board.effort', { percent })}
            </p>
          </div>
        )}
      </header>

      {serverDriven && campaign.status === 'planned' && (
        <ServerPlanApproval
          campaign={campaign}
          allowBypass={remote.state === 'ready' && remote.info.allowBypass}
        />
      )}

      {stalled.length > 0 ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-xs"
          role="status"
          data-testid="campaign-stalled"
        >
          <span>
            {t('settings:campaigns.board.stalled', { n: stalled.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const sid = campaign.tasks.find((x) => x.id === stalled[0])
                ?.sessionId
              if (sid) useCoworkSessions.getState().selectSession(sid)
              void navigate({ to: route.cowork })
            }}
          >
            {t('settings:campaigns.board.action.openCowork')}
          </Button>
        </div>
      ) : null}

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

      {gateFailed ? (
        <GateBanner
          gate={{
            command: campaign.gate?.command,
            exitCode: campaign.gate?.exitCode,
            timedOut: campaign.gate?.timedOut,
            output: campaign.gate?.output,
          }}
          busy={busy}
          onFix={() => void run(() => actions.fixChecks(campaign.id))}
          onRetry={() => void run(() => actions.retryGate(campaign.id))}
          onReview={() => setPanel({ kind: 'changes', gateFailed: true })}
        />
      ) : null}

      {wrapUp ? (
        <WrapUp
          campaign={campaign}
          totals={totals}
          action={
            <Button
              size="sm"
              disabled={busy}
              data-testid="campaign-wrapup-review"
              onClick={() => setPanel({ kind: 'changes' })}
            >
              {t('settings:campaigns.board.action.reviewChanges')}
            </Button>
          }
        />
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
              <span className="ml-2 tabular-nums">
                {group === 'done'
                  ? tasks.filter((x) => x.status !== 'cancelled').length
                  : tasks.length}
              </span>
              {group === 'done' &&
              tasks.some((x) => x.status === 'cancelled') ? (
                <span data-testid="campaign-skipped-count">
                  {' · '}
                  {t('settings:campaigns.board.group.skipped')}
                  <span className="ml-2 tabular-nums">
                    {tasks.filter((x) => x.status === 'cancelled').length}
                  </span>
                </span>
              ) : null}
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
                  events={events}
                  onAction={onAction}
                  loadSummary={loadSummary}
                  loadActivity={loadActivity}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {campaign.tasks.length > 0 ? (
        <CampaignSummary campaign={campaign} totals={totals} />
      ) : null}

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

      <Dialog
        open={panel?.kind === 'changes'}
        onOpenChange={(o) => !o && setPanel(null)}
      >
        <DialogContent className="max-w-3xl" data-testid="campaign-changes-panel">
          <DialogHeader>
            <DialogTitle>
              {t('settings:campaigns.board.changes.title')}
            </DialogTitle>
            <DialogDescription>
              {panel?.kind === 'changes' && panel.gateFailed
                ? t('settings:campaigns.board.gate.reviewWarning')
                : t('settings:campaigns.board.changes.body')}
            </DialogDescription>
          </DialogHeader>
          {panel?.kind === 'changes' && (
            <CampaignChangesBody
              campaignId={campaign.id}
              tasks={campaign.tasks}
              activity={activity}
              loadDiff={loadDiff}
              loadWhole={loadCampaignDiff}
            />
          )}
          {primary === 'review' && (
            <DialogFooter>
              <Button
                size="sm"
                disabled={busy}
                data-testid="campaign-changes-continue"
                onClick={() => {
                  setPanel(null)
                  primaryButton.run()
                }}
              >
                {t('settings:campaigns.board.changes.continue')}
              </Button>
            </DialogFooter>
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

      <Dialog
        open={panel?.kind === 'skipConfirm'}
        onOpenChange={(o) => !o && setPanel(null)}
      >
        <DialogContent data-testid="campaign-skip-confirm">
          <DialogHeader>
            <DialogTitle>
              {t('settings:campaigns.board.skipConfirm.title', {
                task: panel?.kind === 'skipConfirm' ? panel.task.title : '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('settings:campaigns.board.skipConfirm.body', {
                count: panel?.kind === 'skipConfirm' ? panel.count : 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPanel(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid="campaign-skip-cascade"
              onClick={() => {
                if (panel?.kind !== 'skipConfirm') return
                const id = panel.task.id
                setPanel(null)
                void run(() => actions.skipCascade(campaign.id, id))
              }}
            >
              {t('settings:campaigns.board.skipConfirm.cascade', {
                count: panel?.kind === 'skipConfirm' ? panel.count : 0,
              })}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              data-testid="campaign-skip-release"
              onClick={() => {
                if (panel?.kind !== 'skipConfirm') return
                const id = panel.task.id
                setPanel(null)
                // The backend skips the task and releases what waited on it.
                void run(() => actions.releaseDependants(campaign.id, id))
              }}
            >
              {t('settings:campaigns.board.skipConfirm.release')}
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

/**
 * Everything the campaign changed, in one list: each finished task's diff
 * merged by file, shown with the same totals and expandable diffs as a single
 * task's changes. The apply itself stays in the proposal panel.
 */
function CampaignChangesBody({
  campaignId,
  tasks,
  activity,
  loadDiff,
  loadWhole,
}: {
  campaignId: string
  tasks: readonly CampaignTask[]
  /** The whole campaign's diff (the integration branch against the base). */
  loadWhole?: (id: string) => Promise<TaskDiff>
  activity: Record<string, Parameters<typeof changedFilesOf>[0]>
  loadDiff?: (id: string, taskId: string) => Promise<TaskDiff>
}) {
  const included = tasks.filter(
    (x) => hasWork(x) && ['merged', 'verified', 'completed'].includes(x.status)
  )
  const key = included.map((x) => x.id).join(',')
  const recorded = [
    ...new Set(
      included.flatMap((x) => changedFilesOf(activity[x.sessionId ?? '']))
    ),
  ]
  const load = useCallback(async () => {
    // The integration branch's own diff is the truth; a task by task merge
    // is the fallback when it cannot be asked.
    try {
      return await (loadWhole ?? ((id: string) => campaignApi.campaignDiff(id, true)))(
        campaignId
      )
    } catch {
      /* fall through to the per-task diffs */
    }
    const read =
      loadDiff ?? ((id: string, tid: string) => campaignApi.taskDiff(id, tid, true))
    const rows = await Promise.all(
      included.map((x) => read(campaignId, x.id).catch(() => null))
    )
    const known = rows.filter((d): d is TaskDiff => d !== null)
    if (known.length === 0 && included.length > 0) throw new Error('no diff')
    return mergeTaskDiffs(known)
    // `key` stands for the included task ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, key, loadDiff, loadWhole])
  return <TaskChanges load={load} recordedFiles={recorded} />
}
