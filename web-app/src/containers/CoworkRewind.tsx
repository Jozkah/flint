import { useEffect, useId, useRef, useState } from 'react'
import { History, OctagonAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { CheckpointEntry, RewindPlan } from '@/hooks/useCoworkCheckpoints'
import { pathsMatch } from '@/lib/coworkChangeSummary'
import { cn } from '@/lib/utils'

/**
 * Going back to how things were before a turn.
 *
 * Rewind is two operations wearing one word, and this component's whole job is
 * to keep them apart on screen the way the backend keeps them apart in types.
 *
 * **In a tree Flint owns** — a managed worktree — everything in it got there
 * because Flint put it there, so it can be put back. That is a button, behind a
 * confirmation that says what it will do: which tree, which files, and what a
 * restore cannot undo. Before anything is overwritten the current state is
 * saved as a point of its own, so the restore can itself be undone; if that
 * save fails, nothing is restored.
 *
 * **In the user's own checkout** there is work Flint never saw: edits made in
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
  /**
   * Saves the tree as it stands, as a new point, before a restore.
   *
   * Called after the confirmation and before `onRestore`. A failure stops the
   * restore: overwriting a state that could not be saved would be exactly the
   * silent loss this exists to prevent.
   */
  onSafetyCapture: (
    label: string
  ) => Promise<
    { ok: true; point: CheckpointEntry } | { ok: false; reason: string }
  >
  /**
   * The diff a restore would apply, for the "Preview diff" toggle in the
   * confirmation. Optional: without it the toggle is not offered.
   */
  onPreviewDiff?: (
    sha: string
  ) => Promise<{ ok: true; diff: string } | { ok: false; reason: string }>
  /** Carries out a restore. Only ever called for a plan that said `restore`. */
  onRestore: (
    sha: string
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Paths Flint wrote in the latest run, relative to the tree.
   *
   * Edits since the latest point that are not among these are someone
   * else's, and restoring over them needs an explicit acknowledgement.
   */
  janAuthored?: readonly string[]
}

/** A unified diff, one line per row, additions and deletions tinted. */
function RestoreDiffPreview({ diff }: { diff: string }) {
  const { t } = useTranslation()
  const text = diff.trim()
  if (!text) {
    return <p className="text-fg-2">{t('results:rewind.previewEmpty')}</p>
  }
  return (
    <pre
      data-testid="cowork-rewind-diff"
      className="max-h-64 overflow-auto whitespace-pre rounded-md border border-border bg-muted p-2 font-mono"
    >
      {text.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            line.startsWith('+') && !line.startsWith('+++')
              ? 'text-success'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'text-destructive'
                : line.startsWith('@@')
                  ? 'text-muted-foreground'
                  : 'text-fg-2'
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

export function CoworkRewind(props: RewindProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<{
    point: CheckpointEntry
    plan: RewindPlan
  } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [preview, setPreview] = useState<
    | { state: 'loading' }
    | { state: 'ready'; diff: string }
    | { state: 'failed'; reason: string }
    | null
  >(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const ids = useId()

  // A confirmation takes focus when it opens, so a keyboard user lands on the
  // question rather than somewhere behind it.
  useEffect(() => {
    if (open) dialogRef.current?.focus()
  }, [open])

  if (props.points.length === 0) return null

  const close = () => {
    setOpen(null)
    setAcknowledged(false)
    setPreview(null)
    returnFocus.current?.focus()
  }

  const ask = async (point: CheckpointEntry, trigger: HTMLElement) => {
    returnFocus.current = trigger
    setBusy(true)
    setFailure(null)
    setNotice(null)
    setAcknowledged(false)
    setPreview(null)
    try {
      const planned = await props.onPlan(point.sha)
      if (!planned.ok) setFailure(planned.reason)
      else setOpen({ point, plan: planned.plan })
    } finally {
      setBusy(false)
    }
  }

  const janAuthored = props.janAuthored ?? []
  const unrelated =
    open?.plan.kind === 'restore'
      ? (open.plan.changedSinceLatest ?? []).filter(
          (path) => !janAuthored.some((mine) => pathsMatch(path, mine))
        )
      : []
  const blockedByUnrelated = unrelated.length > 0 && !acknowledged

  const doRestore = async () => {
    if (open?.plan.kind !== 'restore' || blockedByUnrelated) return
    setBusy(true)
    setFailure(null)
    try {
      const safety = await props.onSafetyCapture(
        t('results:rewind.safetyLabel', {
          time: new Date().toLocaleTimeString(),
        })
      )
      if (!safety.ok) {
        // The dialog stays open: nothing happened, and the person can try
        // again or back out with the same scope in front of them.
        setFailure(
          t('results:rewind.safetyFailed', { reason: safety.reason })
        )
        return
      }
      const done = await props.onRestore(open.point.sha)
      if (!done.ok) {
        setFailure(done.reason)
        return
      }
      setNotice(t('results:rewind.restored', { label: safety.point.label }))
      close()
    } finally {
      setBusy(false)
    }
  }

  const files = open?.plan.kind === 'restore' ? open.plan.files : undefined

  const togglePreview = async () => {
    if (!open || !props.onPreviewDiff) return
    if (preview) {
      setPreview(null)
      return
    }
    setPreview({ state: 'loading' })
    const result = await props.onPreviewDiff(open.point.sha)
    setPreview(
      result.ok
        ? { state: 'ready', diff: result.diff }
        : { state: 'failed', reason: result.reason }
    )
  }

  return (
    <section
      data-testid="cowork-rewind"
      aria-label={t('common:rewind.title')}
      className="border-t border-dashed border-border px-3 py-2.5 text-xs"
    >
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
        <History aria-hidden className="size-3 shrink-0" />
        {t('common:rewind.title')}
      </p>
      <ul className="grid gap-1">
        {props.points.map((point) => (
          <li key={point.sha} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={point.label}>
              {point.label}
            </span>
            <Button
              variant="surface"
              size="xs"
              className="h-[26px] pointer-coarse:h-11"
              disabled={busy}
              onClick={(event) => void ask(point, event.currentTarget)}
            >
              {t('common:rewind.goBack')}
            </Button>
          </li>
        ))}
      </ul>
      {failure ? (
        <p
          role="alert"
          className="mt-1 flex items-start gap-1.5 text-destructive"
        >
          <OctagonAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{failure}</span>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-1 text-fg-2">
          {notice}
        </p>
      ) : null}

      {open ? (
        <div
          ref={dialogRef}
          role="alertdialog"
          tabIndex={-1}
          aria-label={t('common:rewind.confirmTitle')}
          aria-describedby={
            open.plan.kind === 'restore' ? `${ids}-boundaries` : undefined
          }
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.stopPropagation()
              close()
            }
          }}
          className="mt-2 rounded-xl border-[0.8px] border-border-strong bg-card p-3 shadow-lift outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 motion-safe:animate-rise-in"
        >
          {open.plan.kind === 'restore' ? (
            <>
              <p className="text-sm text-foreground">
                {t('common:rewind.willRestore', { label: open.point.label })}
              </p>
              <div
                className="mt-3 grid gap-1.5"
                data-testid="cowork-rewind-scope"
              >
                <p className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                  {t('results:rewind.scopeTitle')}
                </p>
                <p className="break-all font-mono text-fg-2">
                  {t('results:rewind.scopeTree', { tree: open.point.root })}
                </p>
                {files === undefined ? (
                  <p className="text-fg-2">
                    {t('results:rewind.filesUnknown')}
                  </p>
                ) : files.length === 0 ? (
                  <p className="text-fg-2">
                    {t('results:rewind.noFiles')}
                  </p>
                ) : (
                  <>
                    <p className="text-fg-2">
                      {t('results:rewind.filesHeading', {
                        count: files.length,
                      })}
                    </p>
                    <ul className="max-h-32 overflow-auto rounded-lg border-[0.8px] border-border bg-code-bg px-2 py-1 font-mono">
                      {files.map((path) => (
                        <li key={path} className="break-all">
                          {path}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {props.onPreviewDiff ? (
                  <div className="grid gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-fit pointer-coarse:h-11"
                      aria-expanded={preview !== null}
                      disabled={busy || preview?.state === 'loading'}
                      onClick={() => void togglePreview()}
                    >
                      {preview
                        ? t('results:rewind.hideDiff')
                        : t('results:rewind.previewDiff')}
                    </Button>
                    {preview?.state === 'loading' ? (
                      <p className="text-fg-2">
                        {t('results:rewind.previewLoading')}
                      </p>
                    ) : preview?.state === 'failed' ? (
                      <p className="text-destructive">
                        {t('results:rewind.previewFailed', {
                          reason: preview.reason,
                        })}
                      </p>
                    ) : preview?.state === 'ready' ? (
                      <RestoreDiffPreview diff={preview.diff} />
                    ) : null}
                  </div>
                ) : null}
                <p className="text-fg-2">
                  {t('results:rewind.safetyNote')}
                </p>
                <p
                  id={`${ids}-boundaries`}
                  className="rounded-lg bg-warning-tint px-2.5 py-2 text-foreground"
                >
                  {t('results:rewind.boundaries')}
                </p>
                {unrelated.length > 0 ? (
                  <div
                    role="group"
                    aria-labelledby={`${ids}-unrelated`}
                    data-testid="cowork-rewind-unrelated"
                    className="mt-1 grid gap-1 rounded-lg border-[0.8px] border-destructive/30 bg-destructive-tint p-2.5"
                  >
                    <p id={`${ids}-unrelated`} className="text-destructive">
                      {t('results:rewind.unrelatedTitle')}
                    </p>
                    <ul className="max-h-32 overflow-auto font-mono">
                      {unrelated.map((path) => (
                        <li key={path} className="break-all">
                          {path}
                        </li>
                      ))}
                    </ul>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5 rounded-sm accent-[var(--primary)] outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                        checked={acknowledged}
                        disabled={busy}
                        onChange={(event) =>
                          setAcknowledged(event.currentTarget.checked)
                        }
                      />
                      <span>{t('results:rewind.unrelatedConfirm')}</span>
                    </label>
                  </div>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={busy || blockedByUnrelated}
                  onClick={() => void doRestore()}
                >
                  {t('common:rewind.confirmRestore')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={busy}
                  onClick={close}
                >
                  {t('common:rewind.cancel')}
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* No button, because there is no such operation here. Flint does
                  not own this tree, so the only honest offer is the change
                  itself. */}
              <p className="text-sm text-foreground">
                {t('common:rewind.patchOnly')}
              </p>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg border-[0.8px] border-term-border bg-term-bg p-2.5 font-mono whitespace-pre text-term-fg">
                {open.plan.diff.trim() || t('common:rewind.patchEmpty')}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 pointer-coarse:h-11"
                onClick={close}
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
