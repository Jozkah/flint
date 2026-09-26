import { useEffect, useState } from 'react'
import { Copy, FolderOpen, GitBranch, GitMerge, GitPullRequest, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import { useCoworkParallel } from '@/hooks/useCoworkParallel'
import {
  copyApi,
  lineDiff,
  sessionCommitMessage,
  type CopyChange,
  type FilePair,
} from '@/lib/coworkParallel'
import { describePending } from '@/lib/coworkWorktrees'

/**
 * The session's own worktree (or copy), and what can be done with it.
 *
 * Shown over the composer while a session works in a managed worktree: the
 * branch it is on, and the ways its work leaves that worktree -- merged into
 * the base branch, sent as a pull request, or discarded. Discarding and merging
 * both name what they affect before doing anything.
 *
 * For a folder that is not a Git repository the same place offers "Work on a
 * copy", and once a session works on one, "Apply changes back" with a per-file
 * review.
 */
export type SessionWorktreeBarProps = {
  sessionId: string
  title: string
  folder: string
  record: WorktreeRecord | undefined
  /** The attached folder is a plain folder the session could copy. */
  offerCopy: boolean
  onWorkOnCopy: () => Promise<void>
  /** Ask the session to push its branch and open a pull request. */
  onCreatePr: (branch: string, base: string) => void
  /** The worktree was removed; the session goes back to review-only. */
  onDiscarded: () => void
}

type Confirm =
  | { kind: 'merge'; pending: string[] }
  | { kind: 'discard'; pending: string[]; unmerged: string[] }

export function CoworkSessionWorktreeBar(props: SessionWorktreeBarProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  const record = props.record

  if (!record) {
    if (!props.offerCopy) return null
    return (
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-main-view-fg/10 px-3 py-2 text-xs text-main-view-fg/70">
        <Copy className="size-3.5 shrink-0" />
        <span className="flex-1">{t('common:coworkParallel.copyOffer')}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await props.onWorkOnCopy()
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('common:coworkParallel.workOnCopy')}
        </Button>
      </div>
    )
  }

  const isCopy = record.kind === 'copy'
  const base = record.baseBranch ?? ''
  const dataFolder = async () =>
    (await serviceHub.app().getJanDataFolder().catch(() => '')) ?? ''

  const askMerge = async () => {
    setBusy(true)
    try {
      setConfirm({
        kind: 'merge',
        pending: await useCoworkWorktrees.getState().pending(record),
      })
    } finally {
      setBusy(false)
    }
  }

  const askDiscard = async () => {
    setBusy(true)
    try {
      const store = useCoworkWorktrees.getState()
      const [pending, unmerged] = await Promise.all([
        store.pending(record),
        store.unmerged(record),
      ])
      setConfirm({ kind: 'discard', pending, unmerged })
    } finally {
      setBusy(false)
    }
  }

  const doMerge = async () => {
    setBusy(true)
    try {
      const done = await useCoworkWorktrees
        .getState()
        .merge(props.sessionId, await dataFolder(), sessionCommitMessage(props.title))
      setConfirm(null)
      if (!done.ok) {
        toast.error(done.reason)
        return
      }
      const o = done.outcome
      if (o.conflicts.length > 0)
        toast.error(
          t('common:coworkParallel.conflicts', {
            base: o.target,
            files: describePending(o.conflicts),
          })
        )
      else if (o.alreadyMerged)
        toast.info(t('common:coworkParallel.alreadyMerged', { base: o.target }))
      else if (o.fastForward)
        toast.success(t('common:coworkParallel.mergedFf', { base: o.target }))
      else toast.success(t('common:coworkParallel.merged', { base: o.target }))
    } finally {
      setBusy(false)
    }
  }

  const doDiscard = async (force: boolean) => {
    setBusy(true)
    try {
      const done = await useCoworkWorktrees
        .getState()
        .discard(props.sessionId, await dataFolder(), force)
      setConfirm(null)
      if (!done.ok) {
        toast.error(done.reason)
        return
      }
      if (isCopy) useCoworkParallel.getState().setCopy(props.sessionId, null)
      toast.success(t('common:coworkParallel.discarded'))
      props.onDiscarded()
    } finally {
      setBusy(false)
    }
  }

  const loses =
    confirm?.kind === 'discard'
      ? [...confirm.pending, ...confirm.unmerged]
      : []

  return (
    <>
      <div
        className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-main-view-fg/10 px-3 py-1.5 text-xs"
        data-testid="session-worktree-bar"
      >
        {isCopy ? (
          <Copy className="size-3.5 shrink-0 text-main-view-fg/60" />
        ) : (
          <GitBranch className="size-3.5 shrink-0 text-main-view-fg/60" />
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono"
          title={
            isCopy
              ? t('common:coworkParallel.copyTitle', { folder: props.folder })
              : t('common:coworkParallel.branchTitle', { branch: record.branch })
          }
        >
          {isCopy ? t('common:coworkParallel.copyLabel') : record.branch}
          {!isCopy && base ? (
            <span className="text-main-view-fg/50">
              {' '}
              {t('common:coworkParallel.basedOn', { base })}
            </span>
          ) : null}
        </span>
        <Button
          size="sm"
          variant="ghost"
          title={record.path}
          onClick={() => void serviceHub.opener().openPath(record.path)}
        >
          <FolderOpen className="size-3.5" />
          {t('common:coworkParallel.openFolder')}
        </Button>
        {isCopy ? (
          <Button size="sm" variant="ghost" onClick={() => setApplyOpen(true)}>
            <GitMerge className="size-3.5" />
            {t('common:coworkParallel.applyBack')}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !base}
              onClick={() => void askMerge()}
            >
              <GitMerge className="size-3.5" />
              {base
                ? t('common:coworkParallel.merge', { base })
                : t('common:coworkParallel.mergeNoBase')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => props.onCreatePr(record.branch, base)}
            >
              <GitPullRequest className="size-3.5" />
              {t('common:coworkParallel.createPr')}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void askDiscard()}
        >
          <Trash2 className="size-3.5" />
          {t('common:coworkParallel.discard')}
        </Button>
        {(record.notes?.length ?? 0) > 0 ||
        record.uncommittedAtCreation.length > 0 ? (
          <div className="basis-full text-main-view-fg/60">
            {[
              ...(record.notes ?? []),
              ...(record.uncommittedAtCreation.length > 0
                ? [
                    t('common:coworkParallel.notCarried', {
                      files: describePending(record.uncommittedAtCreation),
                    }),
                  ]
                : []),
            ].join(' ')}
          </div>
        ) : null}
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'merge'
                ? t('common:coworkParallel.mergeTitle', {
                    branch: record.branch,
                    base,
                  })
                : t('common:coworkParallel.discardTitle')}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === 'merge'
                ? t('common:coworkParallel.mergeBody')
                : t('common:coworkParallel.discardBody', {
                    path: record.path,
                    branch: record.branch || '-',
                  })}
            </DialogDescription>
          </DialogHeader>
          {confirm?.kind === 'merge' && confirm.pending.length > 0 ? (
            <FileList
              heading={t('common:coworkParallel.mergePending')}
              items={confirm.pending}
            />
          ) : null}
          {confirm?.kind === 'discard' ? (
            loses.length > 0 ? (
              <FileList heading={t('common:coworkParallel.discardLoses')} items={loses} />
            ) : (
              <p className="text-sm text-main-view-fg/70">
                {t('common:coworkParallel.discardNothing')}
              </p>
            )
          ) : null}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
              {t('common:cancel')}
            </Button>
            {confirm?.kind === 'merge' ? (
              <Button size="sm" disabled={busy} onClick={() => void doMerge()}>
                {t('common:coworkParallel.mergeConfirm')}
              </Button>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void doDiscard(loses.length > 0)}
              >
                {t('common:coworkParallel.discardConfirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isCopy ? (
        <CopyApplyDialog
          open={applyOpen}
          onOpenChange={setApplyOpen}
          copyPath={record.path}
          folder={props.folder}
        />
      ) : null}
    </>
  )
}

function FileList({ heading, items }: { heading: string; items: string[] }) {
  return (
    <div className="text-sm">
      <p className="mb-1 text-main-view-fg/80">{heading}</p>
      <ul className="max-h-48 overflow-auto rounded border border-main-view-fg/10 p-2 font-mono text-xs">
        {items.map((item) => (
          <li key={item} className="truncate">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Per-file review of a copy's changes, and applying the chosen ones back. */
function CopyApplyDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  copyPath: string
  folder: string
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [changes, setChanges] = useState<CopyChange[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState<string | null>(null)
  const [pair, setPair] = useState<FilePair | null>(null)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)

  const dataFolder = async () =>
    (await serviceHub.app().getJanDataFolder().catch(() => '')) ?? ''

  const reload = async () => {
    try {
      const found = await copyApi.changes(await dataFolder(), props.copyPath)
      setChanges(found)
      setChosen(new Set(found.filter((c) => !c.conflict).map((c) => c.path)))
    } catch (e) {
      toast.error(String(e))
      setChanges([])
    }
  }

  useEffect(() => {
    if (!props.open) return
    setShown(null)
    setPair(null)
    setForce(false)
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.copyPath])

  useEffect(() => {
    if (!shown) return
    let cancelled = false
    void (async () => {
      const p = await copyApi
        .filePair(await dataFolder(), props.copyPath, shown)
        .catch(() => null)
      if (!cancelled) setPair(p)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, props.copyPath])

  const apply = async () => {
    setBusy(true)
    try {
      const out = await copyApi.apply(
        await dataFolder(),
        props.copyPath,
        [...chosen],
        force
      )
      toast.success(
        t('common:coworkParallel.applied', { count: out.applied.length })
      )
      if (out.skippedConflicts.length > 0)
        toast.warning(
          t('common:coworkParallel.skipped', {
            files: describePending(out.skippedConflicts),
          })
        )
      await reload()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (path: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t('common:coworkParallel.applyTitle', { folder: props.folder })}
          </DialogTitle>
        </DialogHeader>
        {changes === null ? null : changes.length === 0 ? (
          <p className="text-sm text-main-view-fg/70">
            {t('common:coworkParallel.applyNone')}
          </p>
        ) : (
          <div className="grid max-h-[60vh] grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
            <ul className="overflow-auto text-xs" data-testid="copy-changes">
              {changes.map((c) => (
                <li key={c.path} className="flex items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={chosen.has(c.path)}
                    onChange={() => toggle(c.path)}
                    aria-label={c.path}
                  />
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left font-mono ${
                      shown === c.path ? 'underline' : ''
                    }`}
                    onClick={() => setShown(c.path)}
                  >
                    {c.path}
                  </button>
                  <span className="shrink-0 text-main-view-fg/50">
                    {t(`common:coworkParallel.kind.${c.kind}`)}
                  </span>
                  {c.conflict ? (
                    <span className="shrink-0 text-destructive">
                      {t('common:coworkParallel.conflict')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <pre className="overflow-auto rounded border border-main-view-fg/10 p-2 text-xs">
              {pair === null
                ? null
                : pair.binary
                  ? t('common:coworkParallel.binary')
                  : lineDiff(pair.original, pair.copy).map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.kind === 'add'
                            ? 'bg-green-500/15'
                            : line.kind === 'del'
                              ? 'bg-red-500/15'
                              : ''
                        }
                      >
                        {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                        {line.text}
                      </div>
                    ))}
            </pre>
          </div>
        )}
        <DialogFooter className="items-center">
          {changes?.some((c) => c.conflict) ? (
            <label className="mr-auto flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              {t('common:coworkParallel.applyForce')}
            </label>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => props.onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy || chosen.size === 0}
            onClick={() => void apply()}
          >
            {t('common:coworkParallel.applySelected', { count: chosen.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
