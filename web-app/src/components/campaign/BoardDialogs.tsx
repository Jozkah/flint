import { useCallback } from 'react'
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
import { TaskChanges } from '@/components/campaign/TaskChanges'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { campaignApi, type TaskDiff } from '@/lib/campaignApi'
import { mergeTaskDiffs } from '@/lib/campaignDiff'
import { hasWork } from '@/hooks/useCampaignTaskDiff'
import type { BoardActions } from '@/lib/campaignBoardActions'
import type { CampaignTask } from '@/lib/campaignModel'
import { changedFilesOf, type primaryActionOf } from '@/lib/campaignView'

/** Which board dialog is open, and what it was opened for. */
export type BoardPanel =
  | { kind: 'note'; task: CampaignTask }
  | { kind: 'handoff'; task: CampaignTask; text: string }
  | { kind: 'diff'; task: CampaignTask }
  | { kind: 'changes'; gateFailed?: boolean }
  | { kind: 'skipConfirm'; task: CampaignTask; count: number }
  | { kind: 'review'; command: string | null }
  | { kind: 'cancel' }
  | null

type Props = {
  panel: BoardPanel
  onClose: () => void
  campaign: { id: string; title: string; tasks: readonly CampaignTask[] }
  actions: BoardActions
  busy: boolean
  run: (work: () => Promise<unknown>, ok?: string) => Promise<void>
  note: string
  onNoteChange: (note: string) => void
  activity: Record<string, Parameters<typeof changedFilesOf>[0]>
  loadDiff?: (id: string, taskId: string) => Promise<TaskDiff>
  loadCampaignDiff?: (id: string) => Promise<TaskDiff>
  primary: ReturnType<typeof primaryActionOf>
  onPrimary: () => void
}

/** Every dialog the campaign board opens, driven by one `panel` value. */
export function BoardDialogs({
  panel,
  onClose,
  campaign,
  actions,
  busy,
  run,
  note,
  onNoteChange,
  activity,
  loadDiff,
  loadCampaignDiff,
  primary,
  onPrimary,
}: Props) {
  const { t } = useTranslation()
  const changesTask = panel?.kind === 'diff' ? panel.task : null
  return (
    <>
      <Dialog open={panel?.kind === 'note'} onOpenChange={(o) => !o && onClose()}>
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
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder={t('settings:campaigns.board.note.placeholder')}
          />
          <DialogFooter>
            <Button
              size="sm"
              disabled={busy || !note.trim()}
              onClick={() => {
                if (panel?.kind !== 'note') return
                const taskId = panel.task.id
                onClose()
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
        onOpenChange={(o) => !o && onClose()}
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
        onOpenChange={(o) => !o && onClose()}
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
        onOpenChange={(o) => !o && onClose()}
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
                  onClose()
                  onPrimary()
                }}
              >
                {t('settings:campaigns.board.changes.continue')}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={panel?.kind === 'review'} onOpenChange={(o) => !o && onClose()}>
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
                onClose()
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
        onOpenChange={(o) => !o && onClose()}
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
              onClick={() => onClose()}
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
                onClose()
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
                onClose()
                // The backend skips the task and releases what waited on it.
                void run(() => actions.releaseDependants(campaign.id, id))
              }}
            >
              {t('settings:campaigns.board.skipConfirm.release')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={panel?.kind === 'cancel'} onOpenChange={(o) => !o && onClose()}>
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
                onClose()
                void run(() => actions.cancel(campaign.id))
              }}
            >
              {t('settings:campaigns.board.action.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
