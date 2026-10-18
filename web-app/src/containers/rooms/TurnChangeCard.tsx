import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, FileDiff, FilePlus2, FileText, FileX2, FolderOpen, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { changeCounts } from '@/lib/rooms/turnChanges'
import type { RoomChangeDecision, RoomChangedFile, RoomTurnChanges } from '@/lib/rooms/types'
import { splitPatch, type ApplyPreview } from '@/lib/rooms/applyReview'
import { ApplyReviewDialog, FileDiff as PatchFileDiff } from './ApplyReviewDialog'
import { ChangeExcerptDiff, excerptStatus, shortenPath, type ExcerptFileStatus } from './ChangeExcerptDiff'

type T = (key: string, options?: Record<string, unknown>) => string

/** What the card can do with an isolated workspace; absent in previews/tests. */
export type WorkspaceActions = {
  patch: () => Promise<string>
  discard: () => Promise<void>
  /** Apply all of the change, or only `paths`; resolves with the file count. */
  apply: (paths?: string[]) => Promise<number>
  /** The dry run the review shows before Apply. */
  preview: () => Promise<ApplyPreview>
  /** Reverse the last apply in the user's folder. */
  undo: () => Promise<void>
  /** Who produced the change, for the review's header. */
  source?: { name: string; round: number }
}

/** Excerpts open on arrival when the turn touched at most this many files. */
const OPEN_ALL_FILES = 2
/** File rows shown before "Show all files". */
const FILE_ROWS = 5

const STATUS_ICON: Record<ExcerptFileStatus, typeof FileText> = {
  added: FilePlus2,
  deleted: FileX2,
  renamed: FileText,
  modified: FileText,
}
const STATUS_TONE: Record<ExcerptFileStatus, string> = {
  added: 'text-diff-add',
  deleted: 'text-diff-del',
  renamed: 'text-muted-foreground',
  modified: 'text-muted-foreground',
}

const DECISION_TONE: Record<RoomChangeDecision, 'ok' | 'neutral' | 'err'> = {
  applied: 'ok',
  kept: 'neutral',
  discarded: 'err',
}

/** The whole workspace diff, file by file, drawn as the Apply review draws it. */
function PatchView({ patch, t }: { patch: string; t: T }) {
  const files = useMemo(() => splitPatch(patch), [patch])
  return (
    <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto" data-testid="workspace-diff">
      {files.map((f) => (
        <section key={f.path} className="overflow-hidden rounded-lg border-[0.8px] border-border">
          <header className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 font-mono text-[length:calc(var(--ui-font-base)*0.71875)]">
            <FilePath path={f.path} />
            <Counts additions={f.additions} deletions={f.deletions} />
          </header>
          <PatchFileDiff file={f} t={t} />
        </section>
      ))}
    </div>
  )
}

/** `dir/` dim, the file name strong, the whole thing in the title. */
function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')
  return (
    <span className="min-w-0 flex-1 truncate" title={path}>
      {slash >= 0 && <span className="text-muted-foreground">{path.slice(0, slash + 1)}</span>}
      <span className="font-medium text-foreground">{path.slice(slash + 1)}</span>
    </span>
  )
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] tabular-nums">
      <span className="text-diff-add">+{additions}</span>{' '}
      <span className="text-diff-del">−{deletions}</span>
    </span>
  )
}

function FileRow({
  file,
  open,
  onToggle,
  t,
}: {
  file: RoomChangedFile
  open: boolean
  onToggle: () => void
  t: T
}) {
  const status = excerptStatus(file.excerpt)
  const Icon = STATUS_ICON[status]
  return (
    <li className="min-w-0 overflow-hidden rounded-lg border-[0.8px] border-border bg-card" data-testid="change-file">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-8 w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left font-mono text-[length:calc(var(--ui-font-base)*0.71875)] hover:bg-hover-row"
      >
        <ChevronDown
          aria-hidden
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-200', !open && '-rotate-90')}
        />
        <Icon aria-hidden className={cn('size-3.5 shrink-0', STATUS_TONE[status])} />
        <FilePath path={file.path} />
        <Counts additions={file.additions} deletions={file.deletions} />
      </button>
      {open && (
        <div className="border-t border-border">
          {file.binary ? (
            <p className="px-3 py-2 text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">{t('rooms:changes.binary')}</p>
          ) : file.excerpt ? (
            <ChangeExcerptDiff excerpt={file.excerpt} path={file.path} />
          ) : (
            <p className="px-3 py-2 text-[length:calc(var(--ui-font-base)*0.71875)] text-muted-foreground">{t('rooms:changes.noExcerpt')}</p>
          )}
        </div>
      )}
    </li>
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
  // Files applied by a partial Apply; the rest can still be applied.
  const [partial, setPartial] = useState<number | null>(null)
  const [cumulativeView, setCumulativeView] = useState(false)
  const [dialog, setDialog] = useState<null | 'diff' | 'discard'>(null)
  const [reviewing, setReviewing] = useState(false)
  const [patch, setPatch] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-file open state; unset files follow the default for the list's size.
  const [fileOpen, setFileOpen] = useState<Record<string, boolean>>({})
  const [allRows, setAllRows] = useState(false)
  const shown = cumulativeView && changes.cumulative ? changes.cumulative : changes.files
  const counts = changeCounts(shown)
  const isolated = Boolean(changes.workspace && actions)
  const actionable = isolated && state !== 'discarded' && state !== 'applied'
  const rows = allRows || shown.length <= FILE_ROWS ? shown : shown.slice(0, FILE_ROWS)
  const workspace = changes.workspace ? displayPath(changes.workspace) : null
  // Apply takes the whole workspace: say so when that is more than this turn.
  const earlier =
    actionable && changes.cumulative
      ? changes.cumulative.filter((c) => !changes.files.some((f) => f.path === c.path)).length
      : 0

  const loadPreview = useCallback(() => actions!.preview(), [actions])
  const undoApply = () =>
    actions!.undo().then(
      () => {
        setPartial(null)
        setState('kept')
        toast.success(t('rooms:apply.undone'))
      },
      (e) => toast.error(t('rooms:apply.undoFailed', { message: errorText(e) }))
    )
  const applySelected = async (paths: string[] | undefined) => {
    const count = await actions!.apply(paths)
    if (paths) setPartial(count)
    else {
      setPartial(null)
      setState('applied')
    }
    toast.success(t('rooms:apply.applied', { count }), {
      action: { label: t('rooms:apply.undo'), onClick: () => void undoApply() },
    })
  }

  const loadPatch = async (next: 'diff') => {
    setError(null)
    setDialog(next)
    setPatch(null)
    try {
      setPatch(await actions!.patch())
    } catch (e) {
      setError(errorText(e))
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
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const copyWorkspace = async () => {
    if (workspace && (await copyToClipboard(workspace))) toast.success(t('rooms:apply.pathCopied'))
  }

  return (
    <div
      data-testid="turn-changes"
      className="overflow-hidden rounded-xl bg-card shadow-[inset_0_0_0_0.8px_var(--border)]"
    >
      {/* Wraps at narrow widths: the summary keeps its own line, status and Apply drop below it. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pr-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="turn-changes-toggle"
          className="flex min-h-9 min-w-0 flex-[1_1_10rem] cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            aria-hidden
            className={cn('size-3 shrink-0 transition-transform duration-200', open ? 'rotate-0' : '-rotate-90')}
          />
          <FileDiff aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            <span className="font-medium text-foreground">
              {t(counts.fileCount === 1 ? 'rooms:changes.summaryOne' : 'rooms:changes.summaryMany', {
                count: counts.fileCount,
              })}
            </span>{' '}
            <span className="font-mono tabular-nums whitespace-nowrap">
              <span className="text-diff-add">+{counts.additions}</span>{' '}
              <span className="text-diff-del">−{counts.deletions}</span>
            </span>
          </span>
        </button>
        {earlier > 0 && (
          <span
            className="order-last basis-full px-3 pb-1.5 text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground"
            data-testid="turn-changes-earlier"
          >
            {t('rooms:changes.applyIncludesEarlier', { count: earlier })}
          </span>
        )}
        {isolated && (
          <span className="my-1 ml-auto flex shrink-0 items-center gap-1.5" data-testid="turn-changes-status">
            {partial !== null && state !== 'applied' ? (
              <Chip tone="ok" dot>
                {t('rooms:changes.partial', { count: partial })}
              </Chip>
            ) : state === 'idle' ? (
              <span className="text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground">{t('rooms:changes.state.idle')}</span>
            ) : (
              <Chip tone={DECISION_TONE[state]} dot>
                {t(`rooms:changes.state.${state}`)}
              </Chip>
            )}
            {(state === 'applied' || partial !== null) && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 rounded-lg px-2.5 text-xs"
                onClick={() => void undoApply()}
              >
                <Undo2 aria-hidden />
                {t('rooms:apply.undo')}
              </Button>
            )}
            {/* The one step most people take, inline on the summary line; the
                rest (diff, keep, discard) sit in the opened card. Quiet until
                the files are open: the summary line should not shout. */}
            {actionable && (
              <Button
                size="sm"
                variant={open ? 'default' : 'outline'}
                className="h-7 rounded-lg px-2.5 text-xs"
                data-testid="turn-changes-apply"
                title={t('rooms:changes.apply')}
                onClick={() => setReviewing(true)}
              >
                {t('rooms:changes.applyShort')}
              </Button>
            )}
          </span>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-2.5 border-t border-border bg-muted/30 px-3 pt-2.5 pb-3">
          {(workspace || changes.cumulative) && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {changes.cumulative && (
                <div
                  role="group"
                  aria-label={t('rooms:changes.scope')}
                  className="inline-flex w-fit max-w-full shrink-0 gap-0.5 rounded-lg bg-muted p-0.5 text-[length:calc(var(--ui-font-base)*0.71875)]"
                  data-testid="change-scope"
                >
                  {([false, true] as const).map((all) => (
                    <button
                      key={String(all)}
                      type="button"
                      aria-pressed={cumulativeView === all}
                      aria-label={all ? t('rooms:changes.scopeAll') : undefined}
                      onClick={() => setCumulativeView(all)}
                      className={cn(
                        'h-6 cursor-pointer whitespace-nowrap rounded-md px-2 outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/40',
                        cumulativeView === all
                          ? 'bg-card text-foreground shadow-[0_0_0_0.8px_var(--border)]'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t(all ? 'rooms:changes.scopeAllShort' : 'rooms:changes.scopeTurn')}
                    </button>
                  ))}
                </div>
              )}
              {workspace && (
                <button
                  type="button"
                  title={workspace}
                  aria-label={t('rooms:changes.workspace', { path: workspace })}
                  data-testid="change-workspace"
                  onClick={() => void copyWorkspace()}
                  className="flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md border-[0.8px] border-border bg-card px-2 font-mono text-[length:calc(var(--ui-font-base)*0.6875)] text-muted-foreground hover:border-border-strong hover:text-foreground"
                >
                  <FolderOpen aria-hidden className="size-3 shrink-0" />
                  {/* Whole segments go, never half a word; the title has it all. */}
                  <span className="min-w-0 truncate">{shortenPath(workspace, 40)}</span>
                </button>
              )}
            </div>
          )}
          <ul className="flex flex-col gap-1.5">
            {rows.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                open={fileOpen[f.path] ?? shown.length <= OPEN_ALL_FILES}
                onToggle={() =>
                  setFileOpen((s) => ({ ...s, [f.path]: !(s[f.path] ?? shown.length <= OPEN_ALL_FILES) }))
                }
                t={t}
              />
            ))}
          </ul>
          {rows.length < shown.length && (
            <button
              type="button"
              onClick={() => setAllRows(true)}
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t('rooms:changes.showAll', { count: shown.length })}
            </button>
          )}
          {actionable && (
            <div className="flex flex-wrap gap-2" data-testid="turn-changes-actions">
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
            </div>
          )}
        </div>
      )}
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === 'discard' ? t('rooms:changes.discardTitle') : t('rooms:changes.diffTitle')}
            </DialogTitle>
            <DialogDescription>
              {dialog === 'discard' ? t('rooms:changes.discardHint') : t('rooms:changes.diffHint')}
            </DialogDescription>
          </DialogHeader>
          {dialog !== 'discard' &&
            (patch === null && !error ? (
              <p className="text-xs text-muted-foreground">{t('rooms:changes.loading')}</p>
            ) : patch !== null ? (
              patch.trim() ? (
                <PatchView patch={patch} t={t} />
              ) : (
                <p className="text-xs">{t('rooms:changes.empty')}</p>
              )
            ) : null)}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              {/* Viewing a diff has nothing to cancel. */}
              {t(dialog === 'discard' ? 'rooms:controls.cancel' : 'common:close')}
            </Button>
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
      {isolated && (
        <ApplyReviewDialog
          open={reviewing}
          onOpenChange={setReviewing}
          load={loadPreview}
          onApply={applySelected}
          source={actions!.source}
          t={t}
        />
      )}
    </div>
  )
}

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)

/**
 * A path as the system writes it: a Windows path (drive letter or a
 * backslash) built from parts joined with '/' shows with backslashes only.
 */
function displayPath(path: string): string {
  // No trailing separator: it reads as a stray character after the name.
  const trimmed = path.length > 3 ? path.replace(/[\\/]+$/, '') : path
  return /^[a-z]:[\\/]|\\/i.test(trimmed) ? trimmed.replace(/\//g, '\\') : trimmed
}
