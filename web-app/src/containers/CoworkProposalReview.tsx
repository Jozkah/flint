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
  exportWorktree,
  flagsOf,
  listProposals,
  proposeFromWorktree,
  rejectProposal,
  unacknowledgedSelection,
  type Conflict,
  type Outcome,
  type ProposalRecord,
  type ProposedFile,
  type ReviewFlag,
} from '@/lib/proposals'

const FLAG_LABEL: Record<ReviewFlag['kind'], string> = {
  dependency: 'Dependency change',
  lockfile: 'Lock file',
  migration: 'Irreversible migration',
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
      className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 p-1.5 text-xs"
      data-testid="proposal-flags"
    >
      {flags.map((flag, i) => (
        <div key={i} data-testid="proposal-flag" data-kind={flag.kind}>
          <p className="font-medium text-amber-700 dark:text-amber-300">
            {FLAG_LABEL[flag.kind]}: {flag.summary}
          </p>
          {flag.details.length > 0 ? (
            <ul className="ml-4 list-disc text-main-view-fg/70">
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
  propose,
  title,
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
}) {
  const [proposal, setProposal] = useState<ProposalRecord | null>(null)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [acknowledged, setAcknowledged] = useState<string[]>([])
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
    if (!proposal) return
    const approval = approvalFor(proposal, selected, acknowledged)
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
            ? `${title ?? 'Proposed changes'} to ${worktree.sourceRoot}`
            : (title ??
              'This run works in its own copy. Nothing reaches your folder until you apply it.')}
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
        {exportBundle ? (
          <Button
            size="sm"
            variant="ghost"
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
          className="mt-1 break-all text-xs text-main-view-fg/70"
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
          className="mt-1 text-xs text-main-view-fg/70"
          data-testid="proposal-message"
        >
          {message}
        </p>
      ) : null}
      {proposal ? (
        <>
          {proposal.scope.subject ? (
            <p
              className="mt-1 text-[11px] text-main-view-fg/60"
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
                <ul className="mt-2 flex flex-col gap-1">{source.map(row)}</ul>
                {locks.length > 0 ? (
                  <div className="mt-2" data-testid="proposal-lockfiles">
                    <p className="text-[11px] font-medium text-main-view-fg/60">
                      Lock files ({locks.length}), kept apart from the source
                      changes above
                    </p>
                    <ul className="mt-1 flex flex-col gap-1">{locks.map(row)}</ul>
                  </div>
                ) : null}
              </>
            )
          })()}
          {waiting.length > 0 ? (
            <p
              className="mt-2 text-xs text-amber-700 dark:text-amber-300"
              data-testid="proposal-needs-ack"
            >
              Mark {waiting.join(', ')} as reviewed, or leave {waiting.length === 1 ? 'it' : 'them'} out, to apply.
            </p>
          ) : null}
          <div className="mt-2 flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy != null || waiting.length > 0}
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
