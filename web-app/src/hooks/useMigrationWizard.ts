import { useCallback, useEffect, useRef, useState } from 'react'
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

export type MigrationStep = 'detect' | 'nolegacy' | 'choose' | 'review' | 'running' | 'result'

/**
 * The migration assistant's state machine (Q2-038): detect -> choose -> plan
 * -> execute, with rollback and retry. The dialog only renders what it says.
 */
export function useMigrationWizard({
  open,
  openedManually,
  openFirstRun,
  closeAssistant,
}: {
  open: boolean
  openedManually: boolean
  openFirstRun: () => void
  closeAssistant: () => void
}) {
  const [step, setStep] = useState<MigrationStep>('detect')
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
  const stepRef = useRef<MigrationStep>(step)
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

  return {
    step,
    setStep,
    detect,
    mode,
    setMode,
    selected,
    toggleCategory,
    defaultConflict,
    setDefaultConflict,
    plan,
    result,
    error,
    busy,
    rolledBack,
    buildPlan,
    runExecute,
    onContinue,
    onRollback,
    onNotNow,
    onNeverAsk,
    locked,
    onOpenChange,
  }
}
