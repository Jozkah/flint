import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Loader2, Maximize2, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { copyToClipboard } from '@/lib/clipboard'
import { cn, truncateMiddle } from '@/lib/utils'
import {
  buildPatch,
  canApply,
  dirtyOverlap,
  preflight,
  splitPatch,
  summarize,
  type ApplyPreview,
} from '@/lib/rooms/applyReview'
import { Checkbox } from '@/components/ui/checkbox'
import { ApplyChip } from './apply/ApplyChip'
import { FileDiff } from './apply/FileDiff'
import { PatchFileRow } from './apply/PatchFileRow'
import { PreflightPanel } from './apply/PreflightPanel'

type T = (key: string, options?: Record<string, unknown>) => string

/** Files open on arrival when the whole patch is at most this many rows. */
const OPEN_ALL_ROWS = 600

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)

/** Kept here too: TurnChangeCard imports the diff from this module. */
export { FileDiff }

/**
 * The review step before a participant's change is written into the user's
 * folder: which folder, what each file gets (as a real diff), whether it
 * applies (dry run on open), which of the user's own uncommitted edits it
 * touches, and a per-file choice of what to apply.
 */
export function ApplyReviewDialog({
  open,
  onOpenChange,
  load,
  onApply,
  source,
  t,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The dry run; called each time the dialog opens. */
  load: () => Promise<ApplyPreview>
  /** Apply the selected files (`undefined` = all of them). */
  onApply: (paths: string[] | undefined) => Promise<void>
  /** Who produced the change. */
  source?: { name: string; round: number }
  t: T
}) {
  const [preview, setPreview] = useState<ApplyPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // `load` is read through a ref so a new function identity on re-render does
  // not reload the preview and wipe the user's file selection.
  const loadRef = useRef(load)
  loadRef.current = load

  const files = useMemo(() => (preview ? splitPatch(preview.patch) : []), [preview])

  useEffect(() => {
    if (!open) return
    let live = true
    setPreview(null)
    setLoadError(null)
    setApplyError(null)
    loadRef.current().then(
      (p) => {
        if (!live) return
        const parsed = splitPatch(p.patch)
        const rows = parsed.reduce((n, f) => n + f.diff.hunks.reduce((m, h) => m + h.lines.length + 1, 0), 0)
        setPreview(p)
        setSelected(new Set(parsed.map((f) => f.path)))
        setExpanded(new Set(rows <= OPEN_ALL_ROWS ? parsed.map((f) => f.path) : parsed.slice(0, 1).map((f) => f.path)))
      },
      (e) => live && setLoadError(errorText(e))
    )
    return () => {
      live = false
    }
  }, [open])

  const chosen = files.filter((f) => selected.has(f.path))
  const total = summarize(files)
  const pick = summarize(chosen)
  const check = preflight(preview, selected, loadError)
  const dirty = dirtyOverlap(preview, files, selected)
  const dirtySet = new Set(preview?.dirty ?? [])
  const reasons = new Map((preview?.files ?? []).map((f) => [f.path, f]))
  const allSelected = files.length > 0 && selected.size === files.length
  const allExpanded = files.length > 0 && files.every((f) => expanded.has(f.path))
  const conflicting = files.filter((f) => reasons.get(f.path)?.ok === false && !preview?.clean)

  const toggle = (set: Set<string>, path: string) => {
    const next = new Set(set)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  }

  const leaveOutConflicts = () =>
    setSelected((s) => {
      const next = new Set(s)
      for (const f of conflicting) next.delete(f.path)
      return next
    })

  const apply = async () => {
    setBusy(true)
    setApplyError(null)
    try {
      await onApply(allSelected ? undefined : chosen.map((f) => f.path))
      onOpenChange(false)
    } catch (e) {
      setApplyError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string, done: string) => {
    if (await copyToClipboard(text)) toast.success(done)
  }

  const blockedReason =
    check.state === 'conflict'
      ? t('rooms:apply.blockedConflict')
      : check.state === 'nothing'
        ? t('rooms:apply.blockedNothing')
        : check.state === 'failed'
          ? t('rooms:apply.blockedFailed')
          : null

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        data-testid="apply-review"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancelRef.current?.focus()
        }}
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl sm:pb-0 lg:max-w-4xl xl:max-w-4xl"
      >
        <ApplyHeader
          preview={preview}
          count={preview ? pick.fileCount : total.fileCount}
          total={total}
          source={source}
          onCopy={(text, done) => void copy(text, done)}
          t={t}
        />

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 sm:px-6">
          <PreflightPanel
            check={check}
            dirty={dirty}
            onLeaveOutConflicts={leaveOutConflicts}
            t={t}
          />

          {preview && files.length === 0 && <p className="text-xs text-muted-foreground">{t('rooms:changes.empty')}</p>}

          {files.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 px-1">
                <label className="flex min-h-6 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    className="size-3.5"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && !allSelected
                    }}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(files.map((f) => f.path)))}
                  />
                  {t('rooms:apply.selectAll')}
                </label>
                <button
                  type="button"
                  onClick={() => setExpanded(allExpanded ? new Set() : new Set(files.map((f) => f.path)))}
                  aria-label={allExpanded ? t('common:changes.collapseAll') : t('common:changes.expandAll')}
                  title={allExpanded ? t('common:changes.collapseAll') : t('common:changes.expandAll')}
                  className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover-btn hover:text-foreground"
                >
                  {allExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
              </div>

              <ul className="flex flex-col gap-2">
                {files.map((f) => (
                  <PatchFileRow
                    key={f.path}
                    file={f}
                    selected={selected.has(f.path)}
                    expanded={expanded.has(f.path)}
                    conflict={reasons.get(f.path)?.ok === false && !preview?.clean}
                    dirty={dirtySet.has(f.path) || (!!f.oldPath && dirtySet.has(f.oldPath))}
                    onToggleSelected={() => setSelected((s) => toggle(s, f.path))}
                    onToggleExpanded={() => setExpanded((s) => toggle(s, f.path))}
                    t={t}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-border bg-popover px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:px-6 sm:pb-3">
          {/* The left side says why Apply is off, what went wrong, or, when
              nothing is in the way, that this is safe to try. */}
          <DialogDescription
            role={applyError ? 'alert' : undefined}
            className={cn('min-w-0 flex-1 text-xs', applyError ? 'text-destructive' : 'text-muted-foreground')}
          >
            {applyError ?? (preview && blockedReason) ?? t('rooms:apply.safety')}
          </DialogDescription>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t('rooms:controls.cancel')}
            </Button>
            <Button
              variant="outline"
              disabled={!chosen.length}
              onClick={() => void copy(buildPatch(files, selected), t('rooms:apply.patchCopied'))}
            >
              {t('rooms:apply.copyPatch')}
            </Button>
            <Button data-testid="apply-confirm" disabled={busy || !canApply(check)} onClick={() => void apply()}>
              {busy && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
              {t('rooms:apply.confirm', { count: pick.fileCount })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The dialog's header: what is applied, to which folder, how much, by whom. */
function ApplyHeader({
  preview,
  count,
  total,
  source,
  onCopy,
  t,
}: {
  preview: ApplyPreview | null
  count: number
  total: ReturnType<typeof summarize>
  source?: { name: string; round: number }
  onCopy: (text: string, done: string) => void
  t: T
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-5 pt-5 pb-4 sm:px-6">
      <DialogTitle className="text-base leading-snug font-semibold">
        {t('rooms:apply.title', { count })}
      </DialogTitle>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {preview && (
          <button
            type="button"
            title={preview.target}
            onClick={() => onCopy(preview.target, t('rooms:apply.pathCopied'))}
            className="inline-flex h-[22px] min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 font-mono text-xs text-secondary-foreground hover:text-foreground hover:shadow-lift"
            aria-label={t('rooms:apply.copyPath', { path: preview.target })}
          >
            <FolderOpen aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{truncateMiddle(preview.target, 56)}</span>
          </button>
        )}
        {preview && (
          <ApplyChip data-testid="apply-summary" className="gap-1.5">
            <span>{t('rooms:apply.files', { count: total.fileCount })}</span>
            <span className="font-mono tabular-nums">
              <span className="text-diff-add">+{total.additions}</span>{' '}
              <span className="text-diff-del">−{total.deletions}</span>
            </span>
          </ApplyChip>
        )}
        {source && <ApplyChip>{t('rooms:apply.source', { name: source.name, round: source.round })}</ApplyChip>}
      </div>
    </div>
  )
}
