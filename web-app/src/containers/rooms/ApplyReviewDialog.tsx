import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  Loader2,
  Maximize2,
  Minimize2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { copyToClipboard } from '@/lib/clipboard'
import { cn, truncateMiddle } from '@/lib/utils'
import {
  buildPatch,
  canApply,
  capRows,
  diffRows,
  dirtyOverlap,
  gutterNumber,
  preflight,
  ROWS_PAGE,
  splitPatch,
  summarize,
  type ApplyPreview,
  type PatchFile,
  type PatchFileStatus,
} from '@/lib/rooms/applyReview'

type T = (key: string, options?: Record<string, unknown>) => string

/** Files open on arrival when the whole patch is at most this many rows. */
const OPEN_ALL_ROWS = 600

const STATUS_TONE: Record<PatchFileStatus, string> = {
  added: 'bg-success-tint text-success',
  modified: 'bg-muted text-muted-foreground',
  deleted: 'bg-destructive-tint text-destructive',
  renamed: 'bg-warning-tint text-warning',
}

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)

/** A small bordered label on a file row or in the header. */
function Chip({ className, children, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md border-[0.8px] border-border px-1.5 text-xs text-muted-foreground',
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

/**
 * One file of a patch as a gutter diff: one line-number column, +/− marks,
 * long lines wrapped so the dialog never scrolls sideways.
 */
export function FileDiff({ file, t }: { file: PatchFile; t: T }) {
  const rows = useMemo(() => diffRows(file.diff), [file])
  const [limit, setLimit] = useState(ROWS_PAGE)
  if (file.binary) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">{t('rooms:apply.binary')}</p>
  }
  if (rows.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">{t('rooms:apply.noLines')}</p>
  }
  const { shown, hidden } = capRows(rows, limit)
  const width = String(rows.reduce((m, r) => Math.max(m, gutterNumber(r) ?? 0), 0)).length
  const num = { width: `${width + 2}ch` }
  return (
    <div>
      <div className="bg-code-bg font-mono text-xs leading-[1.6]" data-testid="apply-file-diff">
        {shown.map((r, i) =>
          r.kind === 'hunk' ? (
            <div key={i} className="truncate bg-muted/50 px-4 py-1 text-subtle-foreground">
              {r.text}
            </div>
          ) : (
            <div
              key={i}
              data-kind={r.kind}
              className={cn(
                'flex min-w-0',
                r.kind === 'add' && 'bg-diff-add-bg',
                r.kind === 'remove' && 'bg-diff-del-bg',
                r.kind === 'context' && 'text-fg-2',
                r.kind === 'meta' && 'text-muted-foreground italic'
              )}
            >
              <span
                aria-hidden
                style={num}
                className={cn(
                  'shrink-0 select-none py-px pr-2 pl-2 text-right tabular-nums',
                  r.kind === 'add'
                    ? 'bg-diff-add-ln text-diff-add'
                    : r.kind === 'remove'
                      ? 'bg-diff-del-ln text-diff-del'
                      : 'text-subtle-foreground'
                )}
              >
                {gutterNumber(r) ?? ''}
              </span>
              <span
                aria-hidden
                className={cn(
                  'w-5 shrink-0 select-none py-px text-center',
                  r.kind === 'add' && 'text-diff-add',
                  r.kind === 'remove' && 'text-diff-del'
                )}
              >
                {r.kind === 'add' ? '+' : r.kind === 'remove' ? '−' : ''}
              </span>
              <span className="min-w-0 flex-1 py-px pr-4 break-words whitespace-pre-wrap">{r.text || ' '}</span>
            </div>
          )
        )}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + ROWS_PAGE)}
          className="w-full border-t border-border px-4 py-2 text-left text-xs text-muted-foreground hover:bg-hover-row hover:text-foreground"
        >
          {t('rooms:apply.showMore', { count: Math.min(hidden, ROWS_PAGE) })}{' '}
          <span className="opacity-70">{t('rooms:apply.hiddenLines', { count: hidden })}</span>
        </button>
      )}
    </div>
  )
}

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

  const files = useMemo(() => (preview ? splitPatch(preview.patch) : []), [preview])

  useEffect(() => {
    if (!open) return
    let live = true
    setPreview(null)
    setLoadError(null)
    setApplyError(null)
    load().then(
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
  }, [open, load])

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
  const hasIssues = check.state === 'conflict' || check.state === 'failed' || dirty.length > 0

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
        {/* Header: what, where, how much. */}
        <div className="flex flex-col gap-3 border-b border-border px-5 pt-5 pb-4 sm:px-6">
          <DialogTitle className="text-base leading-snug font-semibold">
            {t('rooms:apply.title', { count: preview ? pick.fileCount : total.fileCount })}
          </DialogTitle>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {preview && (
              <button
                type="button"
                title={preview.target}
                onClick={() => void copy(preview.target, t('rooms:apply.pathCopied'))}
                className="inline-flex h-[22px] min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 font-mono text-xs text-secondary-foreground hover:text-foreground hover:shadow-lift"
                aria-label={t('rooms:apply.copyPath', { path: preview.target })}
              >
                <FolderOpen aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{truncateMiddle(preview.target, 56)}</span>
              </button>
            )}
            {preview && (
              <Chip data-testid="apply-summary" className="gap-1.5">
                <span>{t('rooms:apply.files', { count: total.fileCount })}</span>
                <span className="font-mono tabular-nums">
                  <span className="text-diff-add">+{total.additions}</span>{' '}
                  <span className="text-diff-del">−{total.deletions}</span>
                </span>
              </Chip>
            )}
            {source && <Chip>{t('rooms:apply.source', { name: source.name, round: source.round })}</Chip>}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 sm:px-6">
          {/* One quiet line while checking or when all is well; a card with
              one row per issue otherwise. */}
          <div
            role="status"
            aria-live="polite"
            data-testid="apply-preflight"
            data-state={check.state}
            className={cn(
              hasIssues && 'flex flex-col divide-y divide-border rounded-lg border-[0.8px] border-border bg-card'
            )}
          >
            {check.state === 'checking' && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
                {t('rooms:apply.checking')}
              </p>
            )}
            {check.state === 'clean' && (
              <p className={cn('flex items-center gap-2 text-xs font-medium text-success', hasIssues && 'px-3.5 py-3')}>
                <CheckCircle2 aria-hidden className="size-3.5" />
                {t('rooms:apply.clean')}
              </p>
            )}
            {check.state === 'failed' && (
              <div className="flex items-start gap-2.5 px-3.5 py-3 text-xs">
                <XCircle aria-hidden className="mt-px size-4 shrink-0 text-destructive" />
                <p className="min-w-0 break-words text-foreground">{t('rooms:apply.checkFailed', { message: check.message })}</p>
              </div>
            )}
            {check.state === 'conflict' && (
              <div className="flex flex-col gap-2 px-3.5 py-3 text-xs">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <p className="flex min-w-0 basis-full items-center gap-2.5 sm:flex-1 sm:basis-auto">
                    <XCircle aria-hidden className="size-4 shrink-0 text-destructive" />
                    <span className="font-medium text-foreground">
                      {t('rooms:apply.conflict', { count: check.conflicts.length })}
                    </span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="apply-leave-out"
                    className="ml-[26px] self-start sm:ml-0"
                    onClick={leaveOutConflicts}
                  >
                    {t('rooms:apply.leaveOut')}
                  </Button>
                </div>
                <p className="pl-[26px] text-muted-foreground">{t('rooms:apply.conflictHint')}</p>
                <details className="group/d pl-[26px]">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <ChevronDown aria-hidden className="size-3.5 -rotate-90 transition-transform group-open/d:rotate-0" />
                    {t('rooms:apply.details')}
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1 rounded-md bg-code-bg px-3 py-2 font-mono">
                    {check.conflicts.map((c) => (
                      <li key={c.path} className="min-w-0 break-words">
                        <span className="text-foreground">{c.path}</span>
                        <span className="text-muted-foreground"> — {c.reason ?? t('rooms:apply.notChecked')}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
            {dirty.length > 0 && (
              <div data-testid="apply-dirty" className="flex flex-col gap-1 px-3.5 py-3 text-xs">
                <p className="flex items-center gap-2.5">
                  <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
                  <span className="font-medium text-foreground">{t('rooms:apply.dirtyTitle', { count: dirty.length })}</span>
                </p>
                <p className="min-w-0 pl-[26px] font-mono break-words text-muted-foreground">{dirty.join(', ')}</p>
                <p className="pl-[26px] text-muted-foreground">{t('rooms:apply.dirtyHint')}</p>
              </div>
            )}
          </div>

          {preview && files.length === 0 && <p className="text-xs text-muted-foreground">{t('rooms:changes.empty')}</p>}

          {files.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 px-1">
                <label className="flex min-h-6 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
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
                {files.map((f) => {
                  const isOpen = expanded.has(f.path)
                  const on = selected.has(f.path)
                  const bad = reasons.get(f.path)?.ok === false && !preview?.clean
                  const mine = dirtySet.has(f.path) || (!!f.oldPath && dirtySet.has(f.oldPath))
                  const slash = f.path.lastIndexOf('/')
                  return (
                    <li
                      key={f.path}
                      data-testid="apply-file"
                      className={cn(
                        'min-w-0 overflow-hidden rounded-lg border-[0.8px] border-border bg-card transition-opacity',
                        !on && 'opacity-55'
                      )}
                    >
                      <div className="flex min-h-10 items-center gap-2.5 px-3 py-2">
                        <input
                          type="checkbox"
                          className="size-3.5 shrink-0 accent-primary"
                          checked={on}
                          onChange={() => setSelected((s) => toggle(s, f.path))}
                          aria-label={t('rooms:apply.include', { path: f.path })}
                        />
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => setExpanded((s) => toggle(s, f.path))}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                        >
                          <ChevronDown
                            aria-hidden
                            className={cn(
                              'size-3.5 shrink-0 text-muted-foreground transition-transform',
                              !isOpen && '-rotate-90'
                            )}
                          />
                          <span
                            className="min-w-0 truncate font-mono text-xs"
                            title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                          >
                            {slash > 0 && <span className="text-muted-foreground">{f.path.slice(0, slash + 1)}</span>}
                            <span className="font-medium text-foreground">{f.path.slice(slash + 1)}</span>
                            {f.oldPath && (
                              <span className="text-muted-foreground"> {t('rooms:apply.renamedFrom', { path: f.oldPath })}</span>
                            )}
                          </span>
                        </button>
                        {bad && (
                          <Chip className="border-destructive/40 text-destructive max-[479px]:hidden">
                            <XCircle aria-hidden className="size-3" />
                            {t('rooms:apply.fileConflict')}
                          </Chip>
                        )}
                        {mine && (
                          <Chip className="border-warning/40 text-warning max-[479px]:hidden">
                            <AlertTriangle aria-hidden className="size-3" />
                            {t('rooms:apply.fileDirty')}
                          </Chip>
                        )}
                        <span
                          className={cn(
                            'shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium',
                            STATUS_TONE[f.status]
                          )}
                        >
                          {t(`rooms:apply.status.${f.status}`)}
                        </span>
                        {!f.binary && (
                          <span className="hidden min-w-[7ch] shrink-0 text-right whitespace-nowrap font-mono text-xs tabular-nums min-[420px]:inline">
                            <span className="text-diff-add">+{f.additions}</span>{' '}
                            <span className="text-diff-del">−{f.deletions}</span>
                          </span>
                        )}
                      </div>
                      {isOpen && (
                        <div className="border-t border-border">
                          <FileDiff file={f} t={t} />
                        </div>
                      )}
                    </li>
                  )
                })}
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
