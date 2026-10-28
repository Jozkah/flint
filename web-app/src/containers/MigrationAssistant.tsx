import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { IconLoader } from '@tabler/icons-react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'
import {
  migrationDetect,
  migrationPlan,
  migrationExecute,
  migrationRollback,
  migrationDismiss,
  ALL_CATEGORIES,
  type Category,
  type Conflict,
  type DetectResult,
  type MigrationMode,
  type MigrationPlan,
  type MigrationResult,
} from '@/lib/migration'
import {
  COPY_LIKE,
  MigrationChooseStep,
  MigrationResultStep,
  MigrationReviewStep,
} from './migration/MigrationSteps'

type Step = 'detect' | 'nolegacy' | 'choose' | 'review' | 'running' | 'result'

/**
 * First-launch JAN -> Flint migration assistant.
 *
 * Mounted once near the app root. On mount it detects a legacy JAN install and,
 * when a first launch is pending, opens itself. The Settings entry opens the
 * same assistant later ("import from JAN"). Every filesystem effect is done by
 * the Rust core behind the six migration commands; this component only drives
 * detect -> choose -> plan -> execute, and offers rollback/retry on failure.
 */
export function MigrationAssistant() {
  const { t } = useTranslation()
  const { open, openedManually, openFirstRun, closeAssistant } =
    useMigrationAssistant()

  const [step, setStep] = useState<Step>('detect')
  const [detect, setDetect] = useState<DetectResult | null>(null)
  const [mode, setMode] = useState<MigrationMode>('copy')
  const [selected, setSelected] = useState<Set<Category>>(new Set())
  const [defaultConflict, setDefaultConflict] = useState<Conflict>('keep_flint')
  const [plan, setPlan] = useState<MigrationPlan | null>(null)
  const [result, setResult] = useState<MigrationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rolledBack, setRolledBack] = useState(false)

  // Read by the manual-open effect without re-running it on every step change.
  const stepRef = useRef<Step>(step)
  stepRef.current = step
  // Set when a migration finished while the dialog was hidden, so the next
  // open shows that outcome (and Roll back) instead of starting over.
  const unseenResultRef = useRef(false)

  const seedSelection = useCallback((d: DetectResult) => {
    const present = new Set<Category>()
    for (const c of d.legacy?.categories ?? []) {
      if ((c.file_count ?? 0) > 0 || (c.size_bytes ?? 0) > 0) present.add(c.category)
    }
    // Default to every category that actually has data; fall back to all.
    setSelected(present.size > 0 ? present : new Set(ALL_CATEGORIES))
  }, [])

  // Detect once on first mount so the assistant can auto-open on a first launch
  // that has legacy data. A manual open (from Settings) sets `open` directly.
  const autoChecked = useRef(false)
  useEffect(() => {
    if (autoChecked.current) return
    autoChecked.current = true
    migrationDetect()
      .then((d) => {
        if (d.found && d.first_launch_pending) {
          // Auto-open only when there is something to migrate.
          setDetect(d)
          setStep('choose')
          seedSelection(d)
          openFirstRun()
        }
      })
      .catch(() => {
        // Detection is best-effort; a failure just means no prompt.
      })
  }, [openFirstRun, seedSelection])

  // When opened manually (Settings), run detection each time it opens.
  useEffect(() => {
    if (!open || !openedManually) return
    // A migration is still running, or finished while hidden: resume it
    // rather than resetting to detection and losing the result.
    if (stepRef.current === 'running' || unseenResultRef.current) {
      unseenResultRef.current = false
      return
    }
    let alive = true
    setStep('detect')
    setResult(null)
    setError(null)
    setRolledBack(false)
    migrationDetect()
      .then((d) => {
        if (!alive) return
        setDetect(d)
        if (d.found) {
          seedSelection(d)
          setStep('choose')
        } else {
          setStep('nolegacy')
        }
      })
      .catch((e) => {
        if (!alive) return
        setError(String(e))
        setStep('nolegacy')
      })
    return () => {
      alive = false
    }
  }, [open, openedManually, seedSelection])

  const toggleCategory = (c: Category) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  const buildPlan = useCallback(
    async (conflict: Conflict = defaultConflict) => {
      setBusy(true)
      setError(null)
      try {
        const p = await migrationPlan({
          selectedCategories:
            mode === 'reuse' || mode === 'fresh'
              ? []
              : Array.from(selected),
          mode,
          defaultConflict: conflict,
        })
        setPlan(p)
        setStep('review')
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(false)
      }
    },
    [defaultConflict, mode, selected]
  )

  const runExecute = useCallback(
    async (p: MigrationPlan) => {
      setStep('running')
      setBusy(true)
      setError(null)
      try {
        const r = await migrationExecute(p)
        setResult(r)
        setStep('result')
      } catch (e) {
        setError(String(e))
        setResult(null)
        setStep('result')
      } finally {
        setBusy(false)
        if (!useMigrationAssistant.getState().open) {
          unseenResultRef.current = true
        }
      }
    },
    []
  )

  const onContinue = useCallback(async () => {
    if (mode === 'fresh') {
      // Start fresh still records a manifest so the prompt never returns.
      setBusy(true)
      try {
        const p = await migrationPlan({
          selectedCategories: [],
          mode: 'fresh',
          defaultConflict: 'keep_flint',
        })
        await runExecute(p)
      } catch (e) {
        setError(String(e))
      } finally {
        setBusy(false)
      }
      return
    }
    await buildPlan()
  }, [mode, buildPlan, runExecute])

  const onRollback = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await migrationRollback()
      setRolledBack(true)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const onNotNow = useCallback(async () => {
    // First-launch "Not now" just closes; the prompt is due again next launch.
    closeAssistant()
  }, [closeAssistant])

  const onNeverAsk = useCallback(async () => {
    setBusy(true)
    try {
      await migrationDismiss()
    } catch {
      /* best-effort */
    } finally {
      setBusy(false)
      closeAssistant()
    }
  }, [closeAssistant])

  // While the migration (or a plan/rollback call) is in flight the dialog must
  // stay up: hiding it would hide the progress and, later, the Roll back option.
  const locked = busy || step === 'running'

  const onOpenChange = (next: boolean) => {
    if (next || locked) return
    closeAssistant()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[560px] max-w-[92vw]"
        showCloseButton={!locked}
        onEscapeKeyDown={(e) => {
          if (locked) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (locked) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('common:migration.title')}</DialogTitle>
          <DialogDescription>
            {step === 'nolegacy'
              ? t('common:migration.descriptionNoLegacy')
              : t('common:migration.descriptionFound')}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {step === 'detect' && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <IconLoader size={16} className="animate-spin" />
            {t('common:migration.detecting')}
          </div>
        )}

        {step === 'nolegacy' && (
          <div className="py-4 text-sm text-muted-foreground">
            {t('common:migration.noData')}
          </div>
        )}

        {step === 'choose' && (
          <MigrationChooseStep
            detect={detect}
            mode={mode}
            onModeChange={setMode}
            selected={selected}
            onToggleCategory={toggleCategory}
            defaultConflict={defaultConflict}
            onDefaultConflictChange={setDefaultConflict}
          />
        )}

        {step === 'review' && plan && (
          <MigrationReviewStep
            plan={plan}
            defaultConflict={defaultConflict}
            onDefaultConflictChange={setDefaultConflict}
            onReplan={(c) => void buildPlan(c)}
          />
        )}

        {step === 'running' && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <IconLoader size={16} className="animate-spin" />
            {t('common:migration.running')}
          </div>
        )}

        {step === 'result' && (
          <MigrationResultStep
            result={result}
            error={error}
            rolledBack={rolledBack}
          />
        )}

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <div className="flex gap-2">
            {step === 'choose' && !openedManually && (
              <>
                <Button variant="ghost" size="sm" onClick={onNotNow} disabled={busy}>
                  {t('common:migration.notNow')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onNeverAsk}
                  disabled={busy}
                >
                  {t('common:migration.dontAskAgain')}
                </Button>
              </>
            )}
            {step === 'review' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep('choose')}
                disabled={busy}
              >
                {t('common:migration.back')}
              </Button>
            )}
          </div>

          <div className="flex gap-2">
            {step === 'nolegacy' && (
              <Button size="sm" onClick={closeAssistant}>
                {t('common:migration.close')}
              </Button>
            )}
            {step === 'choose' && (
              <Button
                size="sm"
                onClick={onContinue}
                disabled={
                  busy ||
                  (COPY_LIKE.includes(mode) && selected.size === 0)
                }
              >
                {busy ? <IconLoader size={14} className="animate-spin" /> : null}
                {mode === 'fresh'
                  ? t('common:migration.startFresh')
                  : t('common:migration.continue')}
              </Button>
            )}
            {step === 'review' && plan && (
              <Button
                size="sm"
                onClick={() => runExecute(plan)}
                disabled={busy}
              >
                {busy ? <IconLoader size={14} className="animate-spin" /> : null}
                {t('common:migration.migrate')}
              </Button>
            )}
            {/* Same test as the body: a throw (no result) or a complete
                status with an error is a failure, and keeps Roll back. */}
            {step === 'result' &&
              !(result?.status === 'complete' && !result.error) && (
                <>
                  {!(result?.rolled_back || rolledBack) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onRollback}
                      disabled={busy}
                    >
                      {t('common:migration.rollBack')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => setStep('choose')}
                    disabled={busy}
                  >
                    {t('common:migration.retry')}
                  </Button>
                </>
              )}
            {step === 'result' &&
              result?.status === 'complete' &&
              !result.error && (
                <Button
                  size="sm"
                  onClick={() => {
                    // The new data folder is only read at startup.
                    if (result?.restart_required) {
                      const relaunch = window.core?.api?.relaunch
                      if (relaunch) window.core?.api?.relaunch()
                      else {
                        // No relaunch bridge here: say so rather than do nothing.
                        toast.info(t('common:migration.restartManually'))
                        closeAssistant()
                      }
                    } else closeAssistant()
                  }}
                >
                  {result?.restart_required
                    ? t('common:migration.restart')
                    : t('common:migration.done')}
                </Button>
              )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default MigrationAssistant
