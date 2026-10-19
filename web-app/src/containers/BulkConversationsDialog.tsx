import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { flushDeferredStores } from '@/lib/deferredPersistStorage'
import {
  BULK_KINDS,
  planCounts,
  runBulk,
  skipCount,
  type BulkAction,
  type BulkItem,
  type BulkPlan,
  type BulkProgress,
  type BulkReport,
} from '@/lib/bulkConversations'

type Phase = 'confirm' | 'running' | 'done'

type UndoOutcome = { restored: number; failed: { item: BulkItem; error: string }[] }

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: BulkPlan
  act: (item: BulkItem, action: BulkAction) => Promise<void>
  undo?: (items: BulkItem[]) => Promise<UndoOutcome>
  /**
   * Checked when the run starts, not when the dialog opened: false refuses the
   * run (an archive that was turned off meanwhile would delete instead).
   */
  canStart?: () => Promise<boolean>
  /** Called once a run ended (also when stopped), so the page re-reads its lists. */
  onFinished?: () => void
  /** Where the Archive page is (the desktop app only); absent hides the link. */
  onOpenArchive?: () => void
  /** Shows a "keep pinned" switch on the delete confirmation (entry points scoped to one kind). */
  keepPinned?: { value: boolean; onChange: (v: boolean) => void; count: number }
  /** One line saying what the count covers (for example that a list filter is ignored). */
  scopeNote?: string
  /** Offers Archive as the safer way out of the delete confirmation. */
  onSwitchToArchive?: () => void
}

/**
 * Confirms, runs and reports one bulk archive or delete. Archive is one click
 * and can be undone from the result; delete lists what goes and wants the
 * confirmation word typed.
 */
export function BulkConversationsDialog({
  open,
  onOpenChange,
  plan,
  act,
  undo,
  canStart,
  onFinished,
  onOpenArchive,
  keepPinned,
  scopeNote,
  onSwitchToArchive,
}: Props) {
  const { t } = useTranslation()
  const archivePage = !!onOpenArchive
  const [phase, setPhase] = useState<Phase>('confirm')
  const [typed, setTyped] = useState('')
  const [progress, setProgress] = useState<BulkProgress>({ done: 0, total: 0 })
  const [report, setReport] = useState<BulkReport | null>(null)
  const [stopping, setStopping] = useState(false)
  const [refused, setRefused] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState<UndoOutcome | null>(null)
  const abort = useRef<AbortController | null>(null)
  // The plan the run started with: the page recomputes it as stores change.
  const frozen = useRef<BulkPlan>(plan)

  // A fresh open starts at the confirmation again.
  useEffect(() => {
    if (open) {
      setPhase('confirm')
      setTyped('')
      setReport(null)
      setStopping(false)
      setUndone(null)
      setRefused(false)
    }
  }, [open])

  const isDelete = plan.action === 'delete'
  const word = t('settings:bulk.confirmWord')
  const typedOk = !isDelete || typed.trim().toLowerCase() === word.trim().toLowerCase()
  const counts = planCounts(phase === 'confirm' ? plan : frozen.current)
  const shown = phase === 'confirm' ? plan : frozen.current

  const start = async () => {
    if (canStart) {
      const ok = await canStart().catch(() => false)
      if (!ok) {
        setRefused(true)
        return
      }
    }
    setRefused(false)
    frozen.current = plan
    abort.current = new AbortController()
    setPhase('running')
    setProgress({ done: 0, total: plan.items.length })
    const result = await runBulk(plan, act, {
      signal: abort.current.signal,
      onProgress: setProgress,
    })
    // Deferred store writes (Cowork sessions) land before "finished" shows.
    await flushDeferredStores().catch(() => undefined)
    setReport(result)
    setPhase('done')
    onFinished?.()
  }

  const stop = () => {
    abort.current?.abort()
    setStopping(true)
  }

  const undoAll = async () => {
    if (!undo || !report) return
    setUndoing(true)
    const items = report.results.filter((r) => r.ok).map((r) => r.item)
    let outcome: UndoOutcome
    try {
      outcome = await undo(items)
    } catch (e) {
      // The Archive could not be read: nothing was restored, and the button
      // must not hang on "Restoring...".
      const error = e instanceof Error ? e.message : String(e)
      outcome = { restored: 0, failed: items.map((item) => ({ item, error })) }
    }
    setUndone(outcome)
    setUndoing(false)
    onFinished?.()
  }

  const done = report?.results.filter((r) => r.ok).length ?? 0
  const problems = report?.results.filter((r) => !r.ok) ?? []

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-run would hide work that is still going.
        if (phase === 'running' && !next) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-[480px] lg:max-w-[480px] xl:max-w-[480px]"
        showCloseButton={phase !== 'running'}
        data-testid="bulk-dialog"
      >
        {phase === 'confirm' && (
          <>
            <DialogHeader>
              <DialogTitle>
                {isDelete
                  ? t('settings:bulk.deleteTitle')
                  : t('settings:bulk.archiveTitle')}
              </DialogTitle>
              <DialogDescription>
                {isDelete
                  ? t('settings:bulk.deleteBody')
                  : t('settings:bulk.archiveBody')}
              </DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-1 text-sm" data-testid="bulk-list">
              {BULK_KINDS.filter((k) => counts[k] > 0).map((k) => (
                <li key={k} className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">
                    {t(`settings:bulk.kind.${k}`)}: {counts[k]}
                  </span>
                  {isDelete && (
                    <span className="text-xs text-muted-foreground">
                      {t(`settings:bulk.detail.${k}`)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {scopeNote && (
              <p className="text-xs text-muted-foreground" data-testid="bulk-scope">
                {scopeNote}
              </p>
            )}
            {isDelete && keepPinned && keepPinned.count > 0 && (
              <label className="flex min-h-11 items-center justify-between gap-3 text-sm sm:min-h-0">
                <span>
                  {t('settings:bulk.keepPinned')}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t('settings:bulk.pinnedCount', { n: keepPinned.count })}
                  </span>
                </span>
                <Switch
                  checked={keepPinned.value}
                  onCheckedChange={keepPinned.onChange}
                  data-testid="bulk-keep-pinned"
                />
              </label>
            )}
            {isDelete && (
              <p className="text-xs text-muted-foreground">
                {t('settings:bulk.projectsSafe')}
              </p>
            )}
            {(['pinned', 'active', 'unsupported'] as const).some(
              (r) => skipCount(plan, r) > 0
            ) && (
              <p className="text-xs text-muted-foreground" data-testid="bulk-skips">
                {skipCount(plan, 'pinned') > 0 &&
                  `${t('settings:bulk.skippedPinned', { n: skipCount(plan, 'pinned') })} `}
                {skipCount(plan, 'active') > 0 &&
                  `${t('settings:bulk.skippedActive', { n: skipCount(plan, 'active') })} `}
                {skipCount(plan, 'unsupported') > 0 &&
                  t('settings:bulk.skippedNoArchive', { n: skipCount(plan, 'unsupported') })}
              </p>
            )}
            {refused && (
              <p className="text-xs text-destructive" data-testid="bulk-refused">
                {t('settings:bulk.archiveOff')}
              </p>
            )}
            {isDelete && (
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                <span>{t('settings:bulk.typePrompt', { word })}</span>
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('settings:bulk.typeLabel')}
                  data-testid="bulk-confirm-input"
                />
              </label>
            )}
            <DialogFooter className={STICKY_DIALOG_FOOTER}>
              <Button
                variant="surface"
                className="w-full sm:w-auto pointer-coarse:h-11"
                onClick={() => onOpenChange(false)}
              >
                {t('common:cancel')}
              </Button>
              {isDelete && onSwitchToArchive && (
                <Button
                  variant="surface"
                  className="w-full sm:w-auto pointer-coarse:h-11"
                  onClick={onSwitchToArchive}
                  data-testid="bulk-switch-archive"
                >
                  {t('settings:bulk.archiveInstead')}
                </Button>
              )}
              <Button
                variant={isDelete ? 'destructive' : 'default'}
                className="w-full sm:w-auto pointer-coarse:h-11"
                disabled={!typedOk || plan.items.length === 0}
                onClick={() => void start()}
                data-testid="bulk-confirm"
              >
                {isDelete
                  ? t('settings:bulk.confirmDelete', { n: plan.items.length })
                  : t('settings:bulk.confirmArchive', { n: plan.items.length })}
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === 'running' && (
          <>
            <DialogHeader>
              <DialogTitle>
                {isDelete
                  ? t('settings:bulk.deletingTitle')
                  : t('settings:bulk.archivingTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('settings:bulk.progress', {
                  done: progress.done,
                  total: progress.total,
                })}
              </DialogDescription>
            </DialogHeader>
            <Progress
              value={progress.total ? (progress.done / progress.total) * 100 : 0}
              aria-label={t('settings:bulk.progress', {
                done: progress.done,
                total: progress.total,
              })}
            />
            {progress.current && (
              <p className="truncate text-xs text-muted-foreground">
                {progress.current.title || t('archive:untitled')}
              </p>
            )}
            <DialogFooter className={STICKY_DIALOG_FOOTER}>
              <Button
                variant="surface"
                className="w-full sm:w-auto pointer-coarse:h-11"
                disabled={stopping}
                onClick={stop}
                data-testid="bulk-stop"
              >
                {stopping ? t('settings:bulk.stopping') : t('settings:bulk.stop')}
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === 'done' && report && (
          <>
            <DialogHeader>
              <DialogTitle>{t('settings:bulk.doneTitle')}</DialogTitle>
              <DialogDescription data-testid="bulk-summary">
                {undone && undone.restored > 0
                  ? t('settings:bulk.restored', { n: undone.restored })
                  : isDelete
                    ? t('settings:bulk.deleted', { count: done })
                    : t('settings:bulk.archived', { count: done })}
              </DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {report.stopped && (
                <li>{t('settings:bulk.stoppedEarly', { n: report.untouched.length })}</li>
              )}
              {skipCount(shown, 'pinned') > 0 && (
                <li>{t('settings:bulk.skippedPinned', { n: skipCount(shown, 'pinned') })}</li>
              )}
              {skipCount(shown, 'active') > 0 && (
                <li>{t('settings:bulk.skippedActive', { n: skipCount(shown, 'active') })}</li>
              )}
              {skipCount(shown, 'unsupported') > 0 && (
                <li>{t('settings:bulk.skippedNoArchive', { n: skipCount(shown, 'unsupported') })}</li>
              )}
              {!isDelete && done > 0 && archivePage && !(undone && undone.restored > 0) && (
                <li>{t('settings:bulk.inArchive')}</li>
              )}
            </ul>
            {problems.length > 0 && (
              <div className="flex flex-col gap-1" data-testid="bulk-problems">
                <span className="text-xs font-medium text-foreground">
                  {t('settings:bulk.problems', { n: problems.length })}
                </span>
                <ul className="max-h-40 overflow-y-auto text-xs text-muted-foreground">
                  {problems.map((r) => (
                    <li key={`${r.item.kind}:${r.item.id}`} className="break-words py-0.5">
                      {r.item.title || t('archive:untitled')}
                      {': '}
                      {r.skipped
                        ? t('settings:bulk.skippedRunning')
                        : r.kept
                          ? t('settings:bulk.keptInArchive', { reason: r.error })
                          : r.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {undone && undone.failed.length > 0 && (
              <p className="text-xs text-foreground" data-testid="bulk-undone">
                {t('settings:bulk.restoreFailed', { n: undone.failed.length })}
                {undone.failed[0] && (
                  <span className="mt-1 block text-muted-foreground">
                    {undone.failed[0].error}
                  </span>
                )}
              </p>
            )}
            <DialogFooter className={STICKY_DIALOG_FOOTER}>
              {!isDelete && done > 0 && undo && !undone && (
                <Button
                  variant="surface"
                  className="w-full sm:w-auto pointer-coarse:h-11"
                  disabled={undoing}
                  onClick={() => void undoAll()}
                  data-testid="bulk-undo"
                >
                  {undoing ? t('settings:bulk.undoing') : t('settings:bulk.undo')}
                </Button>
              )}
              {!isDelete && done > 0 && archivePage && !undone && (
                <Button
                  variant="surface"
                  className="w-full sm:w-auto pointer-coarse:h-11"
                  onClick={() => {
                    onOpenChange(false)
                    onOpenArchive?.()
                  }}
                >
                  {t('archive:open')}
                </Button>
              )}
              <Button
                className="w-full sm:w-auto pointer-coarse:h-11"
                onClick={() => onOpenChange(false)}
                data-testid="bulk-close"
              >
                {t('common:done')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
