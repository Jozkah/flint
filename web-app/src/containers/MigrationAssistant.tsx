import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { IconLoader } from '@tabler/icons-react'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'
import {
  migrationDetect,
  migrationPlan,
  migrationExecute,
  migrationRollback,
  migrationDismiss,
  ALL_CATEGORIES,
  MODE_LABELS,
  MODE_DESCRIPTIONS,
  CATEGORY_LABELS,
  CONFLICT_LABELS,
  formatBytes,
  type Category,
  type Conflict,
  type DetectResult,
  type MigrationMode,
  type MigrationPlan,
  type MigrationResult,
} from '@/lib/migration'

type Step = 'detect' | 'nolegacy' | 'choose' | 'review' | 'running' | 'result'

const COPY_LIKE: MigrationMode[] = ['copy', 'move']

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
  const { open, openedManually, openAssistant, closeAssistant } =
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
          openAssistant()
        }
      })
      .catch(() => {
        // Detection is best-effort; a failure just means no prompt.
      })
  }, [openAssistant, seedSelection])

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

  const legacyCategories = useMemo(() => {
    const byId = new Map(
      (detect?.legacy?.categories ?? []).map((c) => [c.category, c])
    )
    return ALL_CATEGORIES.map((id) => ({
      id,
      report: byId.get(id),
    })).filter((c) => c.report) // only categories the core reported
  }, [detect])

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

  const conflicts = useMemo(
    () => (plan?.items ?? []).filter((i) => i.conflict),
    [plan]
  )

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
          <DialogTitle>Migrate from JAN</DialogTitle>
          <DialogDescription>
            {step === 'nolegacy'
              ? 'Bring your existing JAN data into Flint.'
              : 'Flint found an existing JAN installation. Choose how to bring your data across.'}
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
            Looking for an existing JAN installation…
          </div>
        )}

        {step === 'nolegacy' && (
          <div className="py-4 text-sm text-muted-foreground">
            No JAN data was found on this machine. There is nothing to migrate —
            you can start using Flint right away.
          </div>
        )}

        {step === 'choose' && (
          <div className="flex flex-col gap-4">
            {detect?.legacy && (
              <div className="rounded-md border border-foreground/10 bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">
                Found JAN data at{' '}
                <span className="font-mono break-all">
                  {detect.legacy.source.data_folder}
                </span>{' '}
                ({formatBytes(detect.legacy.total_size_bytes)}).
              </div>
            )}

            <div className="flex flex-col gap-2">
              {(Object.keys(MODE_LABELS) as MigrationMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  data-testid={`mode-${m}`}
                  onClick={() => setMode(m)}
                  className={
                    'text-left rounded-md border px-3 py-2 transition-colors ' +
                    (mode === m
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-foreground/10 hover:bg-foreground/5')
                  }
                >
                  <div className="text-sm font-medium">{MODE_LABELS[m]}</div>
                  <div className="text-xs text-muted-foreground">
                    {MODE_DESCRIPTIONS[m]}
                  </div>
                </button>
              ))}
            </div>

            {COPY_LIKE.includes(mode) && (
              <div className="flex flex-col gap-2">
                <div className="text-xs font-medium text-muted-foreground">
                  What to bring across
                </div>
                {legacyCategories.map(({ id, report }) => (
                  <label
                    key={id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="flex flex-col">
                      <span>{CATEGORY_LABELS[id]}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatBytes(report?.size_bytes ?? 0)} ·{' '}
                        {report?.file_count ?? 0} files
                      </span>
                    </span>
                    <Switch
                      checked={selected.has(id)}
                      onCheckedChange={() => toggleCategory(id)}
                      aria-label={CATEGORY_LABELS[id]}
                    />
                  </label>
                ))}

                <label className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>If an item already exists in Flint</span>
                  <select
                    className="rounded-md border border-foreground/15 bg-transparent px-2 py-1 text-xs"
                    value={defaultConflict}
                    onChange={(e) =>
                      setDefaultConflict(e.target.value as Conflict)
                    }
                    aria-label="Conflict resolution"
                  >
                    {(Object.keys(CONFLICT_LABELS) as Conflict[]).map((c) => (
                      <option key={c} value={c}>
                        {CONFLICT_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
        )}

        {step === 'review' && plan && (
          <div className="flex flex-col gap-3">
            {!plan.compatible && (
              <p role="alert" className="text-xs text-destructive">
                The JAN data reports a schema this Flint build does not fully
                support. Review the warnings before continuing.
              </p>
            )}
            <div className="rounded-md border border-foreground/10 px-3 py-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mode</span>
                <span className="font-medium">{MODE_LABELS[plan.mode]}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Items</span>
                <span>{plan.items.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Estimated size</span>
                <span>{formatBytes(plan.estimated_bytes)}</span>
              </div>
              {plan.reuse_path && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Reuse path</span>
                  <span className="font-mono text-xs break-all">
                    {plan.reuse_path}
                  </span>
                </div>
              )}
            </div>

            {conflicts.length > 0 && (
              <div className="rounded-md border border-foreground/10 px-3 py-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium">
                    {conflicts.length} conflict
                    {conflicts.length === 1 ? '' : 's'}
                  </span>
                  <select
                    className="rounded-md border border-foreground/15 bg-transparent px-2 py-1 text-xs"
                    value={defaultConflict}
                    onChange={(e) => {
                      const c = e.target.value as Conflict
                      setDefaultConflict(c)
                      // Re-plan so the resolution is applied and re-reviewed.
                      void buildPlan(c)
                    }}
                    aria-label="Resolve conflicts"
                  >
                    {(Object.keys(CONFLICT_LABELS) as Conflict[]).map((c) => (
                      <option key={c} value={c}>
                        {CONFLICT_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <ul className="max-h-28 overflow-y-auto text-xs text-muted-foreground">
                  {conflicts.slice(0, 50).map((i) => (
                    <li key={i.destination} className="truncate">
                      {i.name}
                      {i.conflict?.flint_is_newer
                        ? ' — Flint copy is newer (kept)'
                        : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.warnings.length > 0 && (
              <ul className="text-xs text-amber-600 dark:text-amber-500">
                {plan.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 'running' && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <IconLoader size={16} className="animate-spin" />
            Migrating your data… do not close Flint.
          </div>
        )}

        {step === 'result' && (
          <div className="flex flex-col gap-3 py-1 text-sm">
            {result && result.status === 'complete' && !result.error ? (
              <>
                <div className="font-medium text-green-600 dark:text-green-500">
                  Migration complete.
                </div>
                <ul className="text-xs text-muted-foreground">
                  {result.per_category.map((c) => (
                    <li key={c.category}>
                      {CATEGORY_LABELS[c.category]}: {c.ok_count} ok
                      {c.skipped_count ? `, ${c.skipped_count} skipped` : ''}
                      {c.failed_count ? `, ${c.failed_count} failed` : ''}
                    </li>
                  ))}
                </ul>
                {result.backup_path && (
                  <div className="text-xs text-muted-foreground">
                    A backup of your JAN data was kept at{' '}
                    <span className="font-mono break-all">
                      {result.backup_path}
                    </span>
                    .
                  </div>
                )}
                {result.reuse_path && (
                  <div className="text-xs text-muted-foreground">
                    Flint is now using your JAN data in place at{' '}
                    <span className="font-mono break-all">
                      {result.reuse_path}
                    </span>
                    .
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="font-medium text-destructive">
                  Migration did not complete.
                </div>
                <div className="text-xs text-muted-foreground">
                  {result?.error || error || 'An unknown error occurred.'}
                  {result?.rolled_back || rolledBack
                    ? ' Your data was rolled back to its previous state.'
                    : ''}
                </div>
                {result?.quarantine_dir && (
                  <div className="text-xs text-muted-foreground">
                    Partial data was quarantined at{' '}
                    <span className="font-mono break-all">
                      {result.quarantine_dir}
                    </span>
                    .
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <div className="flex gap-2">
            {step === 'choose' && !openedManually && (
              <>
                <Button variant="ghost" size="sm" onClick={onNotNow} disabled={busy}>
                  Not now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onNeverAsk}
                  disabled={busy}
                >
                  Don&apos;t ask again
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
                Back
              </Button>
            )}
          </div>

          <div className="flex gap-2">
            {step === 'nolegacy' && (
              <Button size="sm" onClick={closeAssistant}>
                Close
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
                {mode === 'fresh' ? 'Start fresh' : 'Continue'}
              </Button>
            )}
            {step === 'review' && plan && (
              <Button
                size="sm"
                onClick={() => runExecute(plan)}
                disabled={busy}
              >
                {busy ? <IconLoader size={14} className="animate-spin" /> : null}
                Migrate
              </Button>
            )}
            {step === 'result' &&
              result &&
              result.status !== 'complete' && (
                <>
                  {!(result.rolled_back || rolledBack) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onRollback}
                      disabled={busy}
                    >
                      Roll back
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => setStep('choose')}
                    disabled={busy}
                  >
                    Retry
                  </Button>
                </>
              )}
            {step === 'result' &&
              (!result || result.status === 'complete') && (
                <Button size="sm" onClick={closeAssistant}>
                  Done
                </Button>
              )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default MigrationAssistant
