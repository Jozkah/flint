import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { basenameOf } from '@/lib/coworkPreview'
import {
  planApplyAll,
  runApplyAll,
  toastApplyAll,
  type ApplyAllEntry,
  type ApplyAllResult,
  type SandboxApplyProbe,
} from '@/lib/coworkApplyAll'
import type {
  SandboxApplyOutcome,
  SandboxApplyPlan,
} from '@/lib/coworkSandboxApply'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'

export type SandboxApplyActions = {
  planFor: (path: string) => SandboxApplyPlan | null
  probe: (path: string, plan: SandboxApplyPlan) => Promise<SandboxApplyProbe>
  apply: (path: string, overwrite: boolean) => Promise<SandboxApplyOutcome>
}

/**
 * The confirmation for "Apply all to folder": each file with where it goes, a
 * checkbox per file, overwrites flagged and unticked, and what cannot be
 * applied listed as skipped with why. Applies one file at a time through the
 * same path as the per-file button.
 */
export function CoworkApplyAllDialog({
  open,
  onOpenChange,
  paths,
  actions,
  initial,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  paths: readonly string[]
  actions: SandboxApplyActions
  /** Already planned entries (the automatic apply's conflicts), if any. */
  initial?: ApplyAllEntry[]
}) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<ApplyAllEntry[] | null>(null)
  const [results, setResults] = useState<Record<string, ApplyAllResult>>({})
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!open) return
    setResults({})
    setDone(false)
    setRunning(false)
    if (initial) {
      setEntries(initial)
      return
    }
    setEntries(null)
    let live = true
    void planApplyAll(paths, actions.planFor, actions.probe).then((planned) => {
      if (live) setEntries(planned)
    })
    return () => {
      live = false
    }
    // Planned once per opening; later list changes wait for the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = (path: string, checked: boolean) =>
    setEntries((current) =>
      (current ?? []).map((e) =>
        e.kind === 'apply' && e.path === path ? { ...e, checked } : e
      )
    )

  const chosen = (entries ?? []).filter((e) => e.kind === 'apply' && e.checked)

  const applyChosen = async () => {
    if (!entries) return
    setRunning(true)
    const all = await runApplyAll(entries, actions.apply, (result) =>
      setResults((current) => ({ ...current, [result.path]: result }))
    )
    setRunning(false)
    setDone(true)
    toastApplyAll(all, t)
  }

  const resultText = (result: ApplyAllResult) =>
    result.ok
      ? t(
          result.outcome === 'replaced'
            ? 'common:changes.applyReplaced'
            : 'common:changes.applyCreated'
        )
      : result.conflict
        ? t('common:changes.applyExists')
        : t('common:changes.applyFailed', { message: result.message })

  const skipText = (entry: Extract<ApplyAllEntry, { kind: 'skip' }>) =>
    entry.reason === 'not-in-sandbox'
      ? t('common:changes.applyAllSkipOutside')
      : entry.reason === 'same'
        ? t('common:changes.applyAllSkipSame')
        : entry.reason.message

  const where = (plan: SandboxApplyPlan) =>
    `${basenameOf(plan.folder) || plan.folder}/${plan.destination}`

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent data-testid="cowork-apply-all-dialog">
        <DialogHeader>
          <DialogTitle>{t('common:changes.applyAllTitle')}</DialogTitle>
          <DialogDescription>
            {t('common:changes.applyAllDescription')}
          </DialogDescription>
        </DialogHeader>
        {!entries ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t('common:changes.applyAllChecking')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-dashed divide-border rounded-lg border-[0.8px] border-border text-xs">
            {entries.map((entry) => {
              const result = results[entry.path]
              return (
                <li
                  key={entry.path}
                  className="flex items-start gap-2.5 px-3 py-2"
                  data-testid="apply-all-row"
                  data-kind={entry.kind}
                >
                  {entry.kind === 'apply' ? (
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={entry.checked}
                      disabled={running || done}
                      aria-label={entry.plan.source}
                      onChange={(e) => toggle(entry.path, e.target.checked)}
                    />
                  ) : (
                    <span className="mt-0.5 size-[13px] shrink-0" aria-hidden />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-mono text-fg-2">
                      {entry.plan?.source ?? entry.path}
                    </span>
                    {entry.plan ? (
                      <span className="truncate text-[11px] text-muted-foreground">
                        → {where(entry.plan)}
                      </span>
                    ) : null}
                    {entry.kind === 'skip' ? (
                      <span className="text-[11px] text-muted-foreground">
                        {t('common:changes.applyAllSkipped', {
                          reason: skipText(entry),
                        })}
                      </span>
                    ) : null}
                    {result ? (
                      <span
                        role="status"
                        className={
                          result.ok
                            ? 'text-[11px] text-diff-add'
                            : 'text-[11px] text-destructive'
                        }
                      >
                        {resultText(result)}
                      </span>
                    ) : null}
                  </span>
                  {entry.kind === 'apply' && entry.probe === 'differs' ? (
                    <span className="shrink-0 rounded-[5px] border-[0.8px] border-border bg-card px-1.5 text-[10px] text-destructive">
                      {t('common:changes.applyAllOverwrites')}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          {done ? (
            <Button onClick={() => onOpenChange(false)}>
              {t('common:close')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={running}
                onClick={() => onOpenChange(false)}
              >
                {t('common:cancel')}
              </Button>
              <Button
                disabled={running || chosen.length === 0}
                onClick={() => void applyChosen()}
                data-testid="apply-all-confirm"
              >
                {t('common:changes.applyAllConfirm', { count: chosen.length })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
