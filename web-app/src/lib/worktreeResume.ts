/**
 * Re-attach a reopened session to the worktree it was working in.
 *
 * The renderer does not persist worktree records (a stored record would claim
 * a checkout exists without anyone having looked), so after a restart a
 * session still set to Managed worktree has to find its checkout again. That
 * used to go through `ensure`, which makes a new worktree from the default
 * branch when the old one is gone: the session would be moved to an empty
 * checkout without a word. Resuming now only ever finds: the backend checks
 * the directory is a linked git worktree of this project under Flint's own
 * folder (never a symlink out of it, never the main checkout), and when there
 * is none the binding is cleared, the grant withdrawn, and the reason returned
 * for the caller to tell the user.
 */
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkWorktrees, type WorktreeRecord } from '@/hooks/useCoworkWorktrees'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'

export type ResumeOutcome =
  | { ok: true; record: WorktreeRecord }
  | { ok: false; reason: string }

export async function resumeSessionWorktree(
  sessionId: string,
  project: string,
  dataFolder: string
): Promise<ResumeOutcome> {
  const found = await useCoworkWorktrees
    .getState()
    .resume(sessionId, project, dataFolder)
  if (found.ok) return found
  // Gone, or not a worktree any more: nothing to write into. Back to review
  // only, with no grant and no binding, rather than into a different checkout.
  useCoworkWorktrees.getState().forget(sessionId)
  await useDirectEditGrants.getState().revokeSession(sessionId)
  useCoworkSessions.getState().setAccess(sessionId, 'review-only')
  return found
}
