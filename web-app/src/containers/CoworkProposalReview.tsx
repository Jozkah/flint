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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, GitPullRequestArrow, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'
import {
  applyProposal,
  approvalFor,
  defaultSelection,
  exportWorktree,
  flagsOf,
  listProposals,
  proposeFromWorktree,
  rejectProposal,
  unacknowledgedSelection,
  type Approval,
  type Conflict,
  type Outcome,
  type ProposalRecord,
  type ProposalState,
  type ProposedFile,
  type ReviewFlag,
} from '@/lib/proposals'

const FLAG_LABEL: Record<ReviewFlag['kind'], string> = {
  dependency: 'Dependency change',
  lockfile: 'Lock file',
  migration: 'Irreversible migration',
  binary: 'Binary file',
  deletion: 'Deletion',
}

/** A lock file is shown apart from source changes (AH-155). */
const isLockOnly = (file: ProposedFile) => {
  const flags = flagsOf(file)
  return flags.length > 0 && flags.every((f) => f.kind === 'lockfile')
}

/**
 * What a flagged file means beyond its diff, and the box that says it was
 * read. The backend works the flags out itself and refuses a flagged file
 * whose approval does not name it as acknowledged.
 */
function FileFlags({
  file,
  acknowledged,
  onAcknowledge,
}: {
  file: ProposedFile
  acknowledged: boolean
  onAcknowledge: (value: boolean) => void
}) {
  const flags = flagsOf(file)
  if (flags.length === 0) return null
  return (
    <div
      className="mt-1 rounded-lg bg-warning-tint px-2.5 py-2 text-xs shadow-[inset_0_0_0_0.8px_color-mix(in_oklab,var(--warning)_30%,transparent)]"
      data-testid="proposal-flags"
    >
      {flags.map((flag, i) => (
        <div key={i} data-testid="proposal-flag" data-kind={flag.kind}>
          <p className="font-medium text-warning">
            {FLAG_LABEL[flag.kind]}: {flag.summary}
          </p>
          {flag.details.length > 0 ? (
            <ul className="ml-4 list-disc text-fg-2">
              {flag.details.map((d) => (
                <li key={d} className="font-mono text-[11px]">
                  {d}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
      <label className="mt-1 flex items-center gap-2">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onAcknowledge(e.target.checked)}
          data-testid="proposal-flag-ack"
          data-path={file.path}
        />
        I have reviewed what this changes
      </label>
    </div>
  )
}

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
    // Long lines scroll sideways inside the hunk, never the panel.
    <pre className="mt-1.5 overflow-x-auto rounded-lg border-[0.8px] border-border bg-code-bg py-1 font-mono text-xs leading-5 [scrollbar-width:thin]">
      <div className="w-max min-w-full">
        {shown.map((l, i) => (
          <div
            key={i}
            className={
              l.sign === '+'
                ? 'bg-diff-add-bg px-2 text-diff-add'
                : 'bg-diff-del-bg px-2 text-diff-del'
            }
          >
            <span aria-hidden className="select-none pr-2">
              {l.sign}
            </span>
            {l.text}
          </div>
        ))}
        {lines.length > shown.length ? (
          <div className="px-2 text-muted-foreground">
            … {lines.length - shown.length} more line(s)
          </div>
        ) : null}
      </div>
    </pre>
  )
}

function FileReview({
  file,
  chosen,
  conflicts,
  onChange,
  acknowledged,
  onAcknowledge,
}: {
  file: ProposedFile
  chosen: string[] | undefined
  conflicts: Conflict[]
  onChange: (ids: string[] | undefined) => void
  acknowledged: boolean
  onAcknowledge: (value: boolean) => void
}) {
  const whole = file.hunks.length === 0
  const allChosen = whole
    ? chosen !== undefined
    : file.hunks.every((h) => chosen?.includes(h.id))
  const fileConflict = conflicts.find((c) => c.hunk === '')
  return (
    <li
      className="border-b border-dashed border-border py-2 last:border-b-0"
      data-testid="proposal-file"
      data-path={file.path}
    >
      <label className="flex min-h-8 items-center gap-2 text-xs font-medium text-foreground pointer-coarse:min-h-11">
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
        <span className="shrink-0 text-muted-foreground">{file.change}</span>
        <span className="shrink-0 font-mono text-diff-add">
          +{file.additions}
        </span>
        <span className="shrink-0 font-mono text-diff-del">
          -{file.deletions}
        </span>
      </label>
      {file.sensitive ? (
        <p className="mt-1 text-xs text-destructive">
          Looks like it holds a credential, so it is never applied.
        </p>
      ) : whole ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {file.binary ? 'Binary' : 'Too large to split'}: applied or left
          whole.
        </p>
      ) : null}
      <FileFlags
        file={file}
        acknowledged={acknowledged}
        onAcknowledge={onAcknowledge}
      />
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
        <ul className="mt-1 flex flex-col gap-2">
          {file.hunks.map((h) => {
            const conflict = conflicts.find((c) => c.hunk === h.id)
            return (
              <li key={h.id} data-testid="proposal-hunk" data-hunk={h.id}>
                <label className="flex min-h-7 items-center gap-2 font-mono text-xs text-fg-2 pointer-coarse:min-h-11">
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
  propose,
  title,
  applyWith,
}: {
  /** A run's own record, or just where a team child worked and where to. */
  worktree: WorktreeRecord | Pick<WorktreeRecord, 'path' | 'sourceRoot'>
  session: string
  run?: string
  /** The checkout changed; whatever describes it should be re-read. */
  onApplied?: () => void
  /**
   * How to make the proposal, when it is not a run's own worktree: a team
   * child's is made from its backend record, never from a path sent here.
   */
  propose?: () => Promise<Outcome<{ proposal: ProposalRecord }>>
  title?: string
  /**
   * How to apply, when it is not the plain proposal apply: an imported
   * bundle's approval is also bound to the import (AH-169).
   */
  applyWith?: (
    approval: Approval
  ) => Promise<Outcome<{ state: ProposalState; filesWritten: number }>>
}) {
  const [proposal, setProposal] = useState<ProposalRecord | null>(null)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const applying = useRef(false)
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<
    'create' | 'apply' | 'reject' | 'export' | null
  >(null)
  const [exported, setExported] = useState<string | null>(null)

  // AH-168. Only a run's own worktree record can be exported; a team child's
  // review is made from its backend record and has no record here.
  const exportBundle =
    'branch' in worktree
      ? async () => {
          setBusy('export')
          setError(null)
          const out = await exportWorktree(worktree)
          setBusy(null)
          if (!out.ok) {
            setError(out.message)
            return
          }
          setExported(out.path)
        }
      : null

  const load = useCallback(async () => {
    const all = await listProposals(worktree.sourceRoot)
    const pending =
      all.find(
        (p) => p.state === 'pending' && p.scope.worktree === worktree.path
      ) ?? null
    setProposal(pending)
    setSelected(pending ? defaultSelection(pending) : {})
    setAcknowledged([])
    setConflicts([])
  }, [worktree.sourceRoot, worktree.path])

  useEffect(() => {
    void load()
  }, [load])

  const create = async () => {
    setBusy('create')
    setError(null)
    setMessage(null)
    const out = propose
      ? await propose()
      : 'branch' in worktree
        ? await proposeFromWorktree({ record: worktree, session, run })
        : ({
            ok: false,
            message: 'there is no worktree record to propose from',
            conflicts: [],
          } as const)
    setBusy(null)
    if (!out.ok) {
      setError(out.message)
      return
    }
    setProposal(out.proposal)
    setSelected(defaultSelection(out.proposal))
    setAcknowledged([])
    setConflicts([])
  }

  const waiting = proposal
    ? unacknowledgedSelection(proposal, selected, acknowledged)
    : []

  const apply = async () => {
    // A second click that arrives before the first has re-rendered the
    // button disabled must not send a second approval.
    if (!proposal || applying.current) return
    applying.current = true
    try {
      await applyOnce(proposal)
    } finally {
      applying.current = false
    }
  }

  const applyOnce = async (proposal: ProposalRecord) => {
    const approval = approvalFor(proposal, selected, acknowledged)
    if (approval.files.length === 0) {
      setError('Nothing is selected. Reject the proposal to discard it.')
      return
    }
    setBusy('apply')
    setError(null)
    setMessage(null)
    const out = applyWith
      ? await applyWith(approval)
      : await applyProposal(approval)
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

  // "N of M changes selected": a hunk is one change, and a file that can only
  // be applied whole is one. A credential file is never applied, so it is not
  // offered as a change at all.
  const selection = (proposal?.files ?? []).reduce(
    (acc, file) => {
      if (file.sensitive) return acc
      const chosen = selected[file.path]
      if (file.hunks.length === 0) {
        return {
          total: acc.total + 1,
          chosen: acc.chosen + (chosen !== undefined ? 1 : 0),
        }
      }
      return {
        total: acc.total + file.hunks.length,
        chosen:
          acc.chosen +
          file.hunks.filter((h) => chosen?.includes(h.id)).length,
      }
    },
    { total: 0, chosen: 0 }
  )

  return (
    <section
      className="m-3 rounded-[10px] bg-muted shadow-[inset_0_0_0_0.8px_var(--border)] px-3 py-2.5 text-[12.5px] motion-safe:animate-rise-in"
      data-testid="proposal-review"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitPullRequestArrow size={14} className="shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 basis-40 text-[12.5px] text-fg-2">
          {proposal
            ? `${title ?? 'Proposed changes'} to ${worktree.sourceRoot}`
            : (title ??
              'This run works in its own copy. Nothing reaches your folder until you apply it.')}
        </p>
        {!proposal ? (
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            disabled={busy != null}
            onClick={() => void create()}
            data-testid="proposal-create"
          >
            {busy === 'create' ? 'Collecting…' : 'Review changes'}
          </Button>
        ) : null}
        {exportBundle ? (
          <Button
            size="sm"
            variant="surface"
            disabled={busy != null}
            onClick={() => void exportBundle()}
            data-testid="worktree-export"
          >
            {busy === 'export' ? 'Exporting…' : 'Export as patch'}
          </Button>
        ) : null}
      </div>
      {exported ? (
        <p
          className="mt-1 break-all text-xs text-fg-2"
          data-testid="worktree-export-path"
        >
          Patch bundle written to {exported}
        </p>
      ) : null}
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
          className="mt-1 text-xs text-fg-2"
          data-testid="proposal-message"
        >
          {message}
        </p>
      ) : null}
      {proposal ? (
        <>
          {proposal.scope.subject ? (
            <p
              className="mt-1 text-[11px] text-muted-foreground"
              data-testid="proposal-subject"
            >
              {proposal.scope.subject}
            </p>
          ) : null}
          {(() => {
            const row = (file: ProposedFile) => (
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
                acknowledged={acknowledged.includes(file.path)}
                onAcknowledge={(value) =>
                  setAcknowledged((a) =>
                    value
                      ? [...a.filter((p) => p !== file.path), file.path]
                      : a.filter((p) => p !== file.path)
                  )
                }
              />
            )
            const source = proposal.files.filter((f) => !isLockOnly(f))
            const locks = proposal.files.filter(isLockOnly)
            return (
              <>
                <ul className="mt-1 flex flex-col">{source.map(row)}</ul>
                {locks.length > 0 ? (
                  <div className="mt-2" data-testid="proposal-lockfiles">
                    <p className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
                      Lock files ({locks.length}), kept apart from the source
                      changes above
                    </p>
                    <ul className="mt-1 flex flex-col">{locks.map(row)}</ul>
                  </div>
                ) : null}
              </>
            )
          })()}
          {waiting.length > 0 ? (
            <p
              className="mt-2 text-xs text-warning"
              data-testid="proposal-needs-ack"
            >
              Mark {waiting.join(', ')} as reviewed, or leave {waiting.length === 1 ? 'it' : 'them'} out, to apply.
            </p>
          ) : null}
          {/* The review bar stays in reach while the hunks scroll, with room
              for the home indicator on a phone. */}
          <div
            className="sticky bottom-0 z-[1] -mx-3 mt-2 -mb-2.5 flex flex-wrap items-center gap-2 rounded-b-[10px] border-t border-dashed border-border bg-muted px-3 pt-2 pb-[max(0.625rem,env(safe-area-inset-bottom))]"
            data-testid="proposal-review-bar"
          >
            <p
              className="mr-auto text-xs text-fg-2 tabular-nums"
              aria-live="polite"
              data-testid="proposal-selected-count"
            >
              {selection.chosen} of {selection.total} changes selected
            </p>
            <Button
              size="sm"
              variant="surface"
              className="pointer-coarse:h-11"
              disabled={busy != null}
              onClick={() => void reject()}
              data-testid="proposal-reject"
            >
              <X size={12} />
              Reject
            </Button>
            <Button
              size="sm"
              className="pointer-coarse:h-11"
              disabled={busy != null || waiting.length > 0}
              onClick={() => void apply()}
              data-testid="proposal-apply"
            >
              <Check size={12} />
              {busy === 'apply' ? 'Applying…' : 'Apply selected'}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  )
}
