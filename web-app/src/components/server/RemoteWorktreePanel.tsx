import { useCallback, useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CoworkProposalReview } from '@/containers/CoworkProposalReview'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { listProposals, type ProposalRecord } from '@/lib/proposals'
import {
  commitWorktree,
  discardWorktree,
  mergeWorktree,
  worktreePending,
  worktreeState,
  worktreeUnmerged,
  type RemoteWorktreeState,
} from '@/lib/remoteRunner'
import { useRemoteWorktrees } from '@/lib/remoteWorktree'

const STATE_TEXT: Record<RemoteWorktreeState['state'], string> = {
  ready: 'ready',
  missing: 'folder missing',
  corrupt: 'not a worktree any more',
  'branch-moved': 'branch moved',
  'identity-changed': 'repository changed',
}

type View = {
  state: RemoteWorktreeState
  pending: string[]
  unmerged: string[]
  proposal: ProposalRecord | null
}

/**
 * A server session's isolated checkout: its branch and state, what it holds,
 * the two things a person decides about it (merge into the base branch, or
 * discard), and the review of the proposal its last turn made. Renders
 * nothing for a session without a worktree.
 */
export function RemoteWorktreePanel({ sessionId }: { sessionId: string }) {
  const tick = useRemoteWorktrees((s) => s.ticks[sessionId] ?? 0)
  const streamError = useRemoteWorktrees((s) => s.errors[sessionId])
  const running = useCoworkRun((s) => !!s.runs[sessionId])
  const [view, setView] = useState<View | null>(null)
  const [busy, setBusy] = useState<'merge' | 'discard' | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const state = await worktreeState(sessionId)
      const [pending, unmerged, proposals] = await Promise.all([
        worktreePending(sessionId),
        worktreeUnmerged(sessionId),
        listProposals(state.project).catch(() => [] as ProposalRecord[]),
      ])
      const proposal =
        proposals.find(
          (p) =>
            p.state === 'pending' &&
            p.scope.session === sessionId &&
            p.scope.worktree === state.worktree.path
        ) ?? null
      setView({ state, pending, unmerged, proposal })
    } catch {
      // No worktree (read access, opted out, or discarded): nothing to show.
      setView(null)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load, tick, running])

  if (!view) return null
  const { state, pending, unmerged, proposal } = view
  const base = state.worktree.baseBranch
  const ready = state.state === 'ready'
  const nothing = pending.length === 0 && unmerged.length === 0
  const blocked = running || busy != null

  const merge = async () => {
    setBusy('merge')
    setError(null)
    setMessage(null)
    try {
      if (pending.length > 0) await commitWorktree(sessionId, 'Work from a Flint session')
      const out = await mergeWorktree(sessionId)
      if (out.conflicts.length > 0) {
        setError('Not merged: conflicts in ' + out.conflicts.join(', ') + '. Nothing was changed.')
      } else if (out.alreadyMerged) {
        setMessage('Already in ' + out.target + '.')
      } else {
        setMessage('Merged into ' + out.target + (out.fastForward ? ' (fast-forward).' : '.'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      await load()
    }
  }

  const discard = async () => {
    setBusy('discard')
    setError(null)
    setMessage(null)
    try {
      await discardWorktree(sessionId, true)
      setMessage('Discarded. This session cannot continue without its worktree.')
      setConfirmDiscard(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      await load()
    }
  }

  return (
    <section
      className="m-3 rounded-[10px] bg-muted px-3 py-2.5 text-[12.5px] shadow-[inset_0_0_0_0.8px_var(--border)]"
      data-testid="remote-worktree"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GitBranch size={14} aria-hidden className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-all font-medium" data-testid="remote-worktree-branch">
          {state.worktree.branch}
        </span>
        <span
          className={ready ? 'text-muted-foreground' : 'text-destructive'}
          data-testid="remote-worktree-state"
        >
          {STATE_TEXT[state.state]}
        </span>
        <span className="text-muted-foreground" data-testid="remote-worktree-counts">
          {pending.length} uncommitted, {unmerged.length} to merge
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={blocked || !ready || nothing || !base}
          onClick={() => void merge()}
          data-testid="remote-worktree-merge"
        >
          {busy === 'merge' ? 'Merging...' : 'Merge into ' + (base ?? 'base')}
        </Button>
        {!confirmDiscard ? (
          <Button
            size="sm"
            variant="surface"
            disabled={blocked}
            onClick={() => setConfirmDiscard(true)}
            data-testid="remote-worktree-discard"
          >
            Discard
          </Button>
        ) : (
          <>
            <span className="text-destructive">
              Removes the checkout and its branch, with {pending.length} uncommitted file(s) and{' '}
              {unmerged.length} unmerged commit(s).
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={blocked}
              onClick={() => void discard()}
              data-testid="remote-worktree-discard-confirm"
            >
              Discard anyway
            </Button>
            <Button size="sm" variant="surface" onClick={() => setConfirmDiscard(false)}>
              Keep
            </Button>
          </>
        )}
      </div>
      {streamError ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          Changes were not proposed: {streamError}
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 text-xs text-destructive" role="alert" data-testid="remote-worktree-error">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="remote-worktree-message">
          {message}
        </p>
      ) : null}
      {proposal ? (
        <div className="mt-2" data-testid="remote-worktree-proposal">
          <p className="text-xs text-muted-foreground">
            {proposal.files.length} file(s) changed:{' '}
            {proposal.files
              .slice(0, 6)
              .map((f) => f.path)
              .join(', ')}
            {proposal.files.length > 6 ? ', ...' : ''}
          </p>
          {ready ? (
            <CoworkProposalReview
              worktree={{ path: state.worktree.path, sourceRoot: state.project }}
              session={sessionId}
              onApplied={() => void load()}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
