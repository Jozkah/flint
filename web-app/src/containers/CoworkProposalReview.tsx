/**
 * Reviewing what an isolated run changed, and applying only what is chosen.
 * AH-146/147/148/109.
 *
 * A run in a managed worktree never writes the user's checkout. This is the
 * one way its work gets there: the backend stores the worktree's changes as a
 * proposal, this shows every file and hunk of it, and an approval naming the
 * chosen hunks (by id, with the proposal's hashes) is sent back. The backend
 * merges the chosen hunks around anything edited in the checkout since, and
 * refuses -- writing nothing -- when a chosen hunk overlaps such an edit. Those
 * conflicts are shown against the hunks they belong to.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, GitPullRequestArrow, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'
import {
  applyProposal,
  approvalFor,
  defaultSelection,
  listProposals,
  proposeFromWorktree,
  rejectProposal,
  type Conflict,
  type ProposalRecord,
  type ProposedFile,
} from '@/lib/proposals'

/** Lines of a hunk shown before the rest is summarised. */
const PREVIEW_LINES = 12

function HunkPreview({
  removed,
  added,
}: {
  removed: string[]
  added: string[]
}) {
  const lines = [
    ...removed.map((l) => ({ sign: '-', text: l })),
    ...added.map((l) => ({ sign: '+', text: l })),
  ]
  const shown = lines.slice(0, PREVIEW_LINES)
  return (
    <pre className="mt-1 overflow-x-auto rounded bg-main-view-fg/[0.03] p-1 font-mono text-[11px] leading-4">
      {shown.map((l, i) => (
        <div
          key={i}
          className={l.sign === '+' ? 'text-green-600' : 'text-red-600'}
        >
          {l.sign}
          {l.text}
        </div>
      ))}
      {lines.length > shown.length ? (
        <div className="text-main-view-fg/50">
          … {lines.length - shown.length} more line(s)
        </div>
      ) : null}
    </pre>
  )
}

function FileReview({
  file,
  chosen,
  conflicts,
  onChange,
}: {
  file: ProposedFile
  chosen: string[] | undefined
  conflicts: Conflict[]
  onChange: (ids: string[] | undefined) => void
}) {
  const whole = file.hunks.length === 0
  const allChosen = whole
    ? chosen !== undefined
    : file.hunks.every((h) => chosen?.includes(h.id))
  const fileConflict = conflicts.find((c) => c.hunk === '')
  return (
    <li
      className="rounded border border-main-view-fg/10 p-2"
      data-testid="proposal-file"
      data-path={file.path}
    >
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          disabled={file.sensitive}
          checked={!file.sensitive && allChosen}
          onChange={(e) =>
            onChange(e.target.checked ? file.hunks.map((h) => h.id) : undefined)
          }
          data-testid="proposal-file-toggle"
        />
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        <span className="shrink-0 text-main-view-fg/60">{file.change}</span>
        <span className="shrink-0 font-mono text-green-600">
          +{file.additions}
        </span>
        <span className="shrink-0 font-mono text-red-600">
          -{file.deletions}
        </span>
      </label>
      {file.sensitive ? (
        <p className="mt-1 text-xs text-destructive">
          Looks like it holds a credential, so it is never applied.
        </p>
      ) : whole ? (
        <p className="mt-1 text-xs text-main-view-fg/60">
          {file.binary ? 'Binary' : 'Too large to split'}: applied or left
          whole.
        </p>
      ) : null}
      {fileConflict ? (
        <p
          className="mt-1 text-xs text-destructive"
          role="alert"
          data-testid="proposal-conflict"
        >
          {fileConflict.reason}
        </p>
      ) : null}
      {!file.sensitive && !whole ? (
        <ul className="mt-1 flex flex-col gap-1">
          {file.hunks.map((h) => {
            const conflict = conflicts.find((c) => c.hunk === h.id)
            return (
              <li key={h.id} data-testid="proposal-hunk" data-hunk={h.id}>
                <label className="flex items-center gap-2 text-[11px] text-main-view-fg/70">
                  <input
                    type="checkbox"
                    checked={chosen?.includes(h.id) ?? false}
                    onChange={(e) => {
                      const current = chosen ?? []
                      const next = e.target.checked
                        ? [...current, h.id]
                        : current.filter((id) => id !== h.id)
                      onChange(next.length ? next : undefined)
                    }}
                    data-testid="proposal-hunk-toggle"
                  />
                  Lines {h.oldStart}–{h.oldStart + Math.max(h.oldLen, 1) - 1}
                </label>
                {conflict ? (
                  <p
                    className="text-xs text-destructive"
                    role="alert"
                    data-testid="proposal-conflict"
                  >
                    {conflict.reason}
                  </p>
                ) : null}
                <HunkPreview removed={h.removed} added={h.added} />
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

export function CoworkProposalReview({
  worktree,
  session,
  run,
  onApplied,
}: {
  worktree: WorktreeRecord
  session: string
  run?: string
  /** The checkout changed; whatever describes it should be re-read. */
  onApplied?: () => void
}) {
  const [proposal, setProposal] = useState<ProposalRecord | null>(null)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'create' | 'apply' | 'reject' | null>(null)

  const load = useCallback(async () => {
    const all = await listProposals(worktree.sourceRoot)
    const pending =
      all.find(
        (p) => p.state === 'pending' && p.scope.worktree === worktree.path
      ) ?? null
    setProposal(pending)
    setSelected(pending ? defaultSelection(pending) : {})
    setConflicts([])
  }, [worktree.sourceRoot, worktree.path])

  useEffect(() => {
    void load()
  }, [load])

  const create = async () => {
    setBusy('create')
    setError(null)
    setMessage(null)
    const out = await proposeFromWorktree({ record: worktree, session, run })
    setBusy(null)
    if (!out.ok) {
      setError(out.message)
      return
    }
    setProposal(out.proposal)
    setSelected(defaultSelection(out.proposal))
    setConflicts([])
  }

  const apply = async () => {
    if (!proposal) return
    const approval = approvalFor(proposal, selected)
    if (approval.files.length === 0) {
      setError('Nothing is selected. Reject the proposal to discard it.')
      return
    }
    setBusy('apply')
    setError(null)
    setMessage(null)
    const out = await applyProposal(approval)
    setBusy(null)
    if (!out.ok) {
      setError(out.message)
      setConflicts(out.conflicts)
      return
    }
    setMessage(
      `Applied ${out.filesWritten} file(s)${
        out.state === 'partially-applied' ? '; the rest were left out' : ''
      }.`
    )
    onApplied?.()
    await load()
  }

  const reject = async () => {
    if (!proposal) return
    setBusy('reject')
    setError(null)
    const out = await rejectProposal(proposal)
    setBusy(null)
    if (!out.ok) {
      setError(out.message)
      return
    }
    setMessage('Rejected. Nothing in your folder changed.')
    await load()
  }

  const conflictsByPath = useMemo(() => {
    const map: Record<string, Conflict[]> = {}
    for (const c of conflicts) (map[c.path] ??= []).push(c)
    return map
  }, [conflicts])

  return (
    <section
      className="mb-2 rounded-md border border-main-view-fg/10 p-2"
      data-testid="proposal-review"
    >
      <div className="flex items-center gap-2">
        <GitPullRequestArrow size={14} className="text-main-view-fg/60" />
        <p className="flex-1 text-xs font-medium text-main-view-fg/80">
          {proposal
            ? `Proposed changes to ${worktree.sourceRoot}`
            : 'This run works in its own copy. Nothing reaches your folder until you apply it.'}
        </p>
        {!proposal ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy != null}
            onClick={() => void create()}
            data-testid="proposal-create"
          >
            {busy === 'create' ? 'Collecting…' : 'Review changes'}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p
          className="mt-1 text-xs text-destructive"
          role="alert"
          data-testid="proposal-error"
        >
          <AlertTriangle size={12} className="mr-1 inline" />
          {error}
        </p>
      ) : null}
      {message ? (
        <p
          className="mt-1 text-xs text-main-view-fg/70"
          data-testid="proposal-message"
        >
          {message}
        </p>
      ) : null}
      {proposal ? (
        <>
          <ul className="mt-2 flex flex-col gap-1">
            {proposal.files.map((file) => (
              <FileReview
                key={file.path}
                file={file}
                chosen={selected[file.path]}
                conflicts={conflictsByPath[file.path] ?? []}
                onChange={(ids) =>
                  setSelected((s) => {
                    const next = { ...s }
                    if (ids === undefined) delete next[file.path]
                    else next[file.path] = ids
                    return next
                  })
                }
              />
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy != null}
              onClick={() => void apply()}
              data-testid="proposal-apply"
            >
              <Check size={12} />
              {busy === 'apply' ? 'Applying…' : 'Apply selected'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy != null}
              onClick={() => void reject()}
              data-testid="proposal-reject"
            >
              <X size={12} />
              Reject
            </Button>
          </div>
        </>
      ) : null}
    </section>
  )
}
