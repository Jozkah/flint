import { useState } from 'react'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { CheckpointEntry, RewindPlan } from '@/hooks/useCoworkCheckpoints'

/**
 * Going back to how things were before a turn.
 *
 * Rewind is two operations wearing one word, and this component's whole job is
 * to keep them apart on screen the way the backend keeps them apart in types.
 *
 * **In a tree Jan owns** — a managed worktree — everything in it got there
 * because Jan put it there, so it can be put back. That is a button, behind a
 * confirmation that says what it will do.
 *
 * **In the user's own checkout** there is work Jan never saw: edits made in
 * their editor while the run was going, a half-finished change in a file the
 * run never touched. Restoring over that would delete work whose only sin was
 * being in the same directory. So there is no button — there is a patch, shown
 * for the user to apply themselves, and the component never pretends otherwise.
 *
 * Nothing here happens without a click on the confirmation, and the
 * confirmation always names which of the two it is.
 */

export type RewindProps = {
  /** Points still resolvable in the tree this session is working in. */
  points: readonly CheckpointEntry[]
  /** What rewinding to this point would do. Changes nothing. */
  onPlan: (
    sha: string
  ) => Promise<{ ok: true; plan: RewindPlan } | { ok: false; reason: string }>
  /** Carries out a restore. Only ever called for a plan that said `restore`. */
  onRestore: (
    sha: string
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
}

export function CoworkRewind(props: RewindProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<{
    point: CheckpointEntry
    plan: RewindPlan
  } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (props.points.length === 0) return null

  const ask = async (point: CheckpointEntry) => {
    setBusy(true)
    setFailure(null)
    try {
      const planned = await props.onPlan(point.sha)
      if (!planned.ok) setFailure(planned.reason)
      else setOpen({ point, plan: planned.plan })
    } finally {
      setBusy(false)
    }
  }

  const doRestore = async () => {
    if (open?.plan.kind !== 'restore') return
    setBusy(true)
    try {
      const done = await props.onRestore(open.point.sha)
      if (!done.ok) setFailure(done.reason)
      else setOpen(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="cowork-rewind"
      aria-label={t('common:rewind.title')}
      className="border-b border-border px-3 py-2 text-xs"
    >
      <p className="mb-1 flex items-center gap-1.5 text-main-view-fg/70">
        <History aria-hidden className="size-3.5 shrink-0" />
        {t('common:rewind.title')}
      </p>
      <ul className="grid gap-1">
        {props.points.map((point) => (
          <li key={point.sha} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={point.label}>
              {point.label}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6"
              disabled={busy}
              onClick={() => void ask(point)}
            >
              {t('common:rewind.goBack')}
            </Button>
          </li>
        ))}
      </ul>
      {failure ? (
        <p role="alert" className="mt-1 text-destructive">
          {failure}
        </p>
      ) : null}

      {open ? (
        <div
          role="alertdialog"
          aria-label={t('common:rewind.confirmTitle')}
          className="mt-2 rounded border border-border p-2"
        >
          {open.plan.kind === 'restore' ? (
            <>
              <p>
                {t('common:rewind.willRestore', { label: open.point.label })}
              </p>
              <div className="mt-1 flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6"
                  disabled={busy}
                  onClick={() => void doRestore()}
                >
                  {t('common:rewind.confirmRestore')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6"
                  disabled={busy}
                  onClick={() => setOpen(null)}
                >
                  {t('common:rewind.cancel')}
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* No button, because there is no such operation here. Jan does
                  not own this tree, so the only honest offer is the change
                  itself. */}
              <p>{t('common:rewind.patchOnly')}</p>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-main-view-fg/5 p-2">
                {open.plan.diff.trim() || t('common:rewind.patchEmpty')}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-6"
                onClick={() => setOpen(null)}
              >
                {t('common:rewind.close')}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}
