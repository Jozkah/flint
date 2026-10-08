/**
 * Every isolated team child's work, waiting for review. AH-109.
 *
 * One row per child that ran in a checkout of its own: which task it was,
 * where it worked (worktree, branch, base commit), what it changed, and how it
 * ended. The list is read from the backend, which looks at the worktrees again
 * each time, so it is the same after a restart as before one.
 *
 * Reviewing a child opens the ordinary proposal review: the backend stores its
 * changes as a proposal, the person chooses files and hunks, and the approval
 * is checked against the stored hashes and the folder as it is now before
 * anything is written. There is no second way for a child's work to land.
 *
 * A child that failed, was cancelled or was interrupted, or whose worktree
 * changed after it finished, is shown with that problem in words, and its
 * review stays closed until the person says they have read it. A worktree
 * that is gone, holds a link out of itself, or is no longer the one recorded
 * cannot be reviewed at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, GitBranch, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CoworkProposalReview } from '@/containers/CoworkProposalReview'
import { WorkStatus, type WorkState } from '@/containers/StatusChip'
import { listProposals, type ProposalRecord } from '@/lib/proposals'
import {
  listTeamChildren,
  needsAcknowledgement,
  proposeTeamChild,
  reviewable,
  useTeamChildrenVersion,
  type ChildState,
  type ChildView,
} from '@/lib/teamChildren'

const STATE: Record<ChildState, string> = {
  running: 'Running',
  interrupted: 'Interrupted when Flint stopped',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** The shared work status each child state is shown with: icon and word. */
const WORK_STATE: Record<ChildState, WorkState> = {
  running: 'running',
  // Stopped by something other than the work: it needs a person to look.
  interrupted: 'blocked',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** The newest proposal made from this child's worktree, if any. */
function latestFor(
  view: ChildView,
  proposals: ProposalRecord[]
): ProposalRecord | undefined {
  return proposals.find((p) => p.scope.worktree === view.worktreePath)
}

function ChildRow({
  view,
  proposal,
  onApplied,
  focused,
}: {
  view: ChildView
  proposal: ProposalRecord | undefined
  onApplied: () => void
  /** Brought into view and marked: a task row led here. */
  focused?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [focused])
  const [acknowledged, setAcknowledged] = useState(false)
  const warn = needsAcknowledgement(view)
  // A pending proposal is already stored and immutable, so it stays
  // reviewable even when the worktree it came from is gone.
  const canReview =
    (reviewable(view) || proposal?.state === 'pending') &&
    (!warn || acknowledged)
  const adds = view.files.reduce((n, f) => n + f.additions, 0)
  const dels = view.files.reduce((n, f) => n + f.deletions, 0)

  return (
    <li
      ref={rowRef}
      className={
        focused
          ? 'rounded-[10px] border-[0.8px] border-border bg-card p-2.5 ring-2 ring-ring'
          : 'rounded-[10px] border-[0.8px] border-border bg-card p-2.5'
      }
      data-focused={focused ? 'true' : undefined}
      data-testid="team-child"
      data-task={view.taskId}
      data-state={view.state}
      data-problem={view.problem?.kind ?? ''}
      data-proposal={proposal?.state ?? ''}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono font-medium">{view.taskId}</span>
        <WorkStatus
          state={WORK_STATE[view.state]}
          data-testid="team-child-state"
        >
          {STATE[view.state]}
        </WorkStatus>
        {proposal ? (
          <span
            className="inline-flex h-[18px] items-center rounded-[5px] border-[0.8px] border-border bg-card px-1.5 text-[10.5px] text-secondary-foreground"
            data-testid="team-child-proposal"
          >
            {proposal.state === 'pending'
              ? 'Waiting for review'
              : proposal.state === 'partially-applied'
                ? 'Partly applied'
                : proposal.state === 'applied'
                  ? 'Applied'
                  : 'Rejected'}
          </span>
        ) : null}
        <span className="ml-auto font-mono font-medium text-diff-add">+{adds}</span>
        <span className="font-mono font-medium text-diff-del">-{dels}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] text-fg-2">
        {view.description}
      </p>
      <p
        className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-muted-foreground"
        data-testid="team-child-identity"
      >
        <GitBranch size={10} />
        <span data-testid="team-child-branch">{view.branch}</span>
        <span data-testid="team-child-base">
          from {view.baseSha.slice(0, 10)}
        </span>
        <span className="truncate" data-testid="team-child-worktree">
          {view.worktreePath}
        </span>
      </p>
      {view.overrides.length > 0 ? (
        <p
          className="mt-1 text-[11px] text-warning"
          data-testid="team-child-override"
        >
          Ran side by side with{' '}
          {view.overrides
            .flatMap((o) => o.tasks)
            .filter((t) => t !== view.taskId)
            .join(', ')}{' '}
          at your decision, despite overlapping on{' '}
          {[...new Set(view.overrides.flatMap((o) => o.paths))].join(', ')}.
        </p>
      ) : null}
      {view.files.length > 0 ? (
        <ul className="mt-1 flex flex-col">
          {view.files.map((f) => (
            <li
              key={f.path}
              className="flex items-center gap-2 font-mono text-[11px]"
              data-testid="team-child-file"
              data-path={f.path}
            >
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="text-muted-foreground">{f.change}</span>
              <span className="text-diff-add">+{f.additions}</span>
              <span className="text-diff-del">-{f.deletions}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {view.problem ? (
        <p
          className="mt-1 text-xs text-destructive"
          role="alert"
          data-testid="team-child-problem"
          data-kind={view.problem.kind}
        >
          <AlertTriangle size={12} className="mr-1 inline" />
          {view.problem.message}
        </p>
      ) : null}
      {warn ? (
        <label className="mt-1 flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            data-testid="team-child-acknowledge"
          />
          Review it anyway, knowing this
        </label>
      ) : null}
      <div className="mt-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={!canReview}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid="team-child-review"
        >
          {open ? 'Hide review' : 'Review'}
        </Button>
      </div>
      {open && canReview ? (
        <CoworkProposalReview
          worktree={{ path: view.worktreePath, sourceRoot: view.sourceRoot }}
          session={view.parentSession}
          title={`Changes from task ${view.taskId}`}
          propose={() =>
            proposeTeamChild(view.parentSession, view.taskId, acknowledged)
          }
          onApplied={onApplied}
        />
      ) : null}
    </li>
  )
}

export function CoworkTeamReviews({
  project,
  session,
  onApplied,
  focusTaskId,
}: {
  project: string
  session: string
  onApplied?: () => void
  /** The team task a task row asked to see. */
  focusTaskId?: string | null
}) {
  const [views, setViews] = useState<ChildView[]>([])
  const [proposals, setProposals] = useState<ProposalRecord[]>([])
  const version = useTeamChildrenVersion((s) => s.version)

  // `load` runs from the version effect and from `onApplied`, and both are
  // IPC round trips whose answers can arrive out of order. Only the most
  // recently issued call may write state; an older answer that lands late
  // would otherwise revert an applied review to "waiting".
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const found = await listTeamChildren(project, session)
    if (seq !== loadSeq.current) return
    setViews(found)
    const roots = [...new Set(found.map((v) => v.sourceRoot))]
    const all = (await Promise.all(roots.map((r) => listProposals(r)))).flat()
    if (seq !== loadSeq.current) return
    setProposals(all)
  }, [project, session])

  useEffect(() => {
    void load()
  }, [load, version])

  if (views.length === 0) return null
  return (
    <section
      className="mx-3 mb-3 rounded-[10px] bg-muted shadow-[inset_0_0_0_0.8px_var(--border)] p-3 motion-safe:animate-rise-in"
      aria-label="Work from team tasks"
      data-testid="team-reviews"
    >
      <div className="flex items-center gap-2">
        <Users size={14} className="text-muted-foreground" />
        <p className="flex-1 text-[12.5px] font-medium text-foreground">
          Team tasks that worked in checkouts of their own. Nothing reaches
          your folder until you apply it.
        </p>
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {views.map((view) => (
          <ChildRow
            key={view.ownerId}
            view={view}
            proposal={latestFor(view, proposals)}
            focused={focusTaskId != null && view.taskId === focusTaskId}
            onApplied={() => {
              onApplied?.()
              void load()
            }}
          />
        ))}
      </ul>
    </section>
  )
}
