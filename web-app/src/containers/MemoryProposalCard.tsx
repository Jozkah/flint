/**
 * A memory an agent proposed, waiting for an answer.
 *
 * The card is not the decision. Every button round-trips to the backend, which
 * re-runs the refusals against the content as stored -- a card can sit on
 * screen for a long time, and what was safe to store when it was proposed is
 * not necessarily safe to store now.
 *
 * It never says "needs approval". The gate knows *why* it is asking --
 * automatic saving is off, or this contradicts something already remembered,
 * or it would widen a project fact to everywhere -- and that sentence is the
 * whole value of the card. A generic prompt would make all three look alike and
 * push the user toward answering them all the same way.
 *
 * A conflicted proposal is shown without an Approve button, because approving
 * one side of a disagreement without seeing the other is not a decision anyone
 * can make well. The backend refuses it too; this is the visible half.
 */

import { useCallback, useState } from 'react'
import { Brain, Check, X } from 'lucide-react'
import {
  memoryProposalResolve,
  type MemoryLocation,
  type PendingProposal,
} from '@janhq/tauri-plugin-agent-tools-api'
import { Button } from '@/components/ui/button'
import { errorText } from '@/lib/errorText'
import { cn } from '@/lib/utils'

/** What a scope means, in the words the user chose it in. */
const SCOPE_LABEL: Record<string, string> = {
  session: 'this conversation',
  project: 'this project',
  user: 'everywhere',
}

export function MemoryProposalCard({
  proposal,
  location,
  onResolved,
  onOpenSettings,
}: {
  proposal: PendingProposal
  location: MemoryLocation
  /** Called once the backend has answered, so the list can drop this one. */
  onResolved: (id: string, approved: boolean) => void
  onOpenSettings?: () => void
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const answer = useCallback(
    async (approve: boolean) => {
      if (busy) return
      setBusy(approve ? 'approve' : 'reject')
      setError(null)
      try {
        await memoryProposalResolve(location, proposal.scope, proposal.id, approve)
        onResolved(proposal.id, approve)
      } catch (e) {
        // The backend refused -- a credential spotted at approval time, a
        // conflict, a proposal that is no longer there. Say which.
        setError(errorText(e))
      } finally {
        setBusy(null)
      }
    },
    [busy, location, proposal.id, proposal.scope, onResolved]
  )

  return (
    <div
      className="rounded-lg border border-border bg-card p-3"
      data-testid="memory-proposal-card"
      data-proposal-id={proposal.id}
      data-reason={proposal.reason}
    >
      <div className="flex items-start gap-2">
        <Brain size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-ink-2">
            Remember this?
          </p>
          <p
            className="mt-1 text-sm text-foreground"
            data-testid="memory-proposal-content"
          >
            {proposal.content}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Would apply to {SCOPE_LABEL[proposal.scope] ?? proposal.scope}.
          </p>
          {/* The reason, from the backend. Never a generic prompt. */}
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="memory-proposal-explanation"
          >
            {proposal.explanation}
          </p>

          {error && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1">
            {proposal.approvable ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy != null}
                onClick={() => void answer(true)}
                data-testid="memory-proposal-approve"
              >
                <Check size={12} />
                {busy === 'approve' ? 'Saving…' : 'Remember'}
              </Button>
            ) : (
              // No Approve. Resolving the disagreement is the action, and it
              // lives where both sides can be seen at once.
              <Button
                size="sm"
                variant="ghost"
                onClick={onOpenSettings}
                data-testid="memory-proposal-resolve-conflict"
              >
                Review both
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy != null}
              onClick={() => void answer(false)}
              data-testid="memory-proposal-reject"
            >
              <X size={12} />
              {busy === 'reject' ? 'Discarding…' : 'Discard'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Every proposal awaiting an answer, or nothing at all.
 *
 * Renders no chrome when the list is empty: a heading over an empty area is a
 * standing reminder of a feature the user is not using.
 */
export function MemoryProposalList({
  proposals,
  location,
  onResolved,
  onOpenSettings,
  className,
}: {
  proposals: PendingProposal[]
  location: MemoryLocation
  onResolved: (id: string, approved: boolean) => void
  onOpenSettings?: () => void
  className?: string
}) {
  if (proposals.length === 0) return null
  return (
    <div
      className={cn('flex flex-col gap-2', className)}
      data-testid="memory-proposal-list"
    >
      {proposals.map((proposal) => (
        <MemoryProposalCard
          key={proposal.id}
          proposal={proposal}
          location={location}
          onResolved={onResolved}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </div>
  )
}

export default MemoryProposalCard
