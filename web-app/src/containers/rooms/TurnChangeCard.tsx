import { useState } from 'react'
import { ChevronDown, FileDiff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { changeCounts } from '@/lib/rooms/turnChanges'
import type { RoomChangeDecision, RoomTurnChanges } from '@/lib/rooms/types'

type T = (key: string, options?: Record<string, unknown>) => string

/** What the card can do with an isolated workspace; absent in previews/tests. */
export type WorkspaceActions = {
  patch: () => Promise<string>
  discard: () => Promise<void>
  apply: () => Promise<number>
}

function DiffText({ text }: { text: string }) {
  return (
    <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-2 font-mono text-[11.5px] leading-[1.5]">
      {text.split('\n').map((l, i) => (
        <span
          key={i}
          className={cn(
            'block whitespace-pre-wrap break-all',
            l.startsWith('+') && !l.startsWith('+++') && 'text-emerald-700 dark:text-emerald-400',
            l.startsWith('-') && !l.startsWith('---') && 'text-red-700 dark:text-red-400'
          )}
        >
          {l || ' '}
        </span>
      ))}
    </pre>
  )
}

/**
 * The files one participant turn changed: `N files changed · +a −d`, opening
 * to per-file diff excerpts. For an isolated workspace it can show the whole
 * diff, keep or discard the change, or apply it to the user's folder -- the
 * last only after the patch is shown and confirmed.
 */
export function TurnChangeCard({
  changes,
  actions,
  decision,
  onDecision,
  t,
}: {
  changes: RoomTurnChanges
  actions?: WorkspaceActions
  /** The decision saved with the room, so it is still shown after a reload. */
  decision?: RoomChangeDecision
  /** Save a decision with the room. */
  onDecision?: (decision: RoomChangeDecision) => Promise<void> | void
  t: T
}) {
  const [open, setOpen] = useState(false)
  const [local, setLocal] = useState<RoomChangeDecision | null>(null)
  const state: 'idle' | RoomChangeDecision = local ?? decision ?? 'idle'
  const setState = (next: RoomChangeDecision) => {
    setLocal(next)
    void Promise.resolve(onDecision?.(next)).catch(() => {})
  }
  const [cumulativeView, setCumulativeView] = useState(false)
  const [dialog, setDialog] = useState<null | 'diff' | 'apply' | 'discard'>(null)
  const [patch, setPatch] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = cumulativeView && changes.cumulative ? changes.cumulative : changes.files
  const counts = changeCounts(shown)
  const isolated = Boolean(changes.workspace && actions)

  const loadPatch = async (next: 'diff' | 'apply') => {
    setError(null)
    setDialog(next)
    setPatch(null)
    try {
      setPatch(await actions!.patch())
    } catch (e) {
      setError(e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e))
    }
  }
  const run = async (op: () => Promise<unknown>, done: RoomChangeDecision) => {
    setBusy(true)
    setError(null)
    try {
      await op()
      setState(done)
      setDialog(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="turn-changes" className="rounded-[10px] shadow-[inset_0_0_0_0.8px_var(--border)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-8 w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          aria-hidden
          className={cn('size-3 shrink-0 transition-transform duration-200', open ? 'rotate-0' : '-rotate-90')}
        />
        <FileDiff aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t(counts.fileCount === 1 ? 'rooms:changes.summaryOne' : 'rooms:changes.summaryMany', { count: counts.fileCount })}{' '}
          <span className="font-mono tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{counts.additions}</span>{' '}
            <span className="text-red-600 dark:text-red-400">−{counts.deletions}</span>
          </span>
        </span>
        {isolated && state !== 'idle' && (
          <span className="shrink-0 text-[11px]">{t(`rooms:changes.state.${state}`)}</span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2.5 pb-2.5">
          {changes.workspace && (
            <p className="truncate text-[11px] text-muted-foreground" title={changes.workspace}>
              {t('rooms:changes.workspace', { path: changes.workspace })}
            </p>
          )}
          {changes.cumulative && (
            <div role="group" className="flex gap-1 text-[11px]" data-testid="change-scope">
              <Button
                size="sm"
                variant={cumulativeView ? 'ghost' : 'secondary'}
                aria-pressed={!cumulativeView}
                onClick={() => setCumulativeView(false)}
              >
                {t('rooms:changes.scopeTurn')}
              </Button>
              <Button
                size="sm"
                variant={cumulativeView ? 'secondary' : 'ghost'}
                aria-pressed={cumulativeView}
                onClick={() => setCumulativeView(true)}
              >
                {t('rooms:changes.scopeAll')}
              </Button>
            </div>
          )}
          <ul className="flex flex-col gap-1.5">
            {shown.map((f) => (
              <li key={f.path} className="min-w-0">
                <details className="group/file">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[11.5px] [&::-webkit-details-marker]:hidden">
                    <ChevronDown
                      aria-hidden
                      className="size-3 shrink-0 -rotate-90 transition-transform group-open/file:rotate-0"
                    />
                    <span className="min-w-0 flex-1 truncate">{f.path}</span>
                    <span className="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
                    <span className="shrink-0 tabular-nums text-red-600 dark:text-red-400">−{f.deletions}</span>
                  </summary>
                  <div className="mt-1">
                    {f.binary ? (
                      <p className="text-[11px] text-muted-foreground">{t('rooms:changes.binary')}</p>
                    ) : f.excerpt ? (
                      <DiffText text={f.excerpt} />
                    ) : (
                      <p className="text-[11px] text-muted-foreground">{t('rooms:changes.noExcerpt')}</p>
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
          {isolated && state !== 'discarded' && state !== 'applied' && (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => void loadPatch('diff')}>
                {t('rooms:changes.openDiff')}
              </Button>
              {state !== 'kept' && (
                <Button size="sm" variant="outline" onClick={() => setState('kept')}>
                  {t('rooms:changes.keep')}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setDialog('discard')}>
                {t('rooms:changes.discard')}
              </Button>
              <Button size="sm" onClick={() => void loadPatch('apply')}>
                {t('rooms:changes.apply')}
              </Button>
            </div>
          )}
        </div>
      )}
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === 'apply'
                ? t('rooms:changes.applyTitle')
                : dialog === 'discard'
                  ? t('rooms:changes.discardTitle')
                  : t('rooms:changes.diffTitle')}
            </DialogTitle>
            <DialogDescription>
              {dialog === 'apply'
                ? t('rooms:changes.applyHint')
                : dialog === 'discard'
                  ? t('rooms:changes.discardHint')
                  : t('rooms:changes.diffHint')}
            </DialogDescription>
          </DialogHeader>
          {dialog !== 'discard' &&
            (patch === null && !error ? (
              <p className="text-xs text-muted-foreground">{t('rooms:changes.loading')}</p>
            ) : patch !== null ? (
              patch.trim() ? <DiffText text={patch} /> : <p className="text-xs">{t('rooms:changes.empty')}</p>
            ) : null)}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              {t('rooms:controls.cancel')}
            </Button>
            {dialog === 'apply' && (
              <Button
                disabled={busy || !patch?.trim()}
                onClick={() => void run(() => actions!.apply(), 'applied')}
              >
                {t('rooms:changes.applyConfirm')}
              </Button>
            )}
            {dialog === 'discard' && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void run(() => actions!.discard(), 'discarded')}
              >
                {t('rooms:changes.discardConfirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
