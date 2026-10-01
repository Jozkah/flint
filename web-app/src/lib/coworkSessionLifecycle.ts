import { abortRun } from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions, type CoworkSession } from '@/hooks/useCoworkSessions'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useMessageQueue } from '@/stores/message-queue-store'
import {
  notifySessionArchived,
  notifySessionRemoved,
  notifySessionRestored,
} from '@/lib/mailboxPresence'
import { useSessionMessaging } from '@/hooks/useSessionMessaging'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { archiveApi, archiveEnabled } from '@/lib/archive'

/**
 * Delete a Cowork session, stopping its run first (janhq/jan#8905).
 *
 * Deleting a session that was running used to leave its run streaming into a
 * session that no longer existed, with its questions and approvals still
 * pending. Now the run is stopped -- that run only; other sessions keep
 * theirs -- and everything held for the session is dropped, so a late event
 * from the stopped run finds nothing to write to and is refused.
 */
export function deleteCoworkSession(
  id: string,
  opts?: { keepRecords?: boolean }
): void {
  // The model stream, the tool loop, every subagent and any open question.
  abortRun(id, 'deleted')
  useCoworkRun.getState().forgetSession(id)
  useToolApprovalRequests.getState().clearPendingForThread(id)
  // A temporary Git grant is scoped to the conversation and dies with it.
  useToolApprovalRequests.getState().forgetTemporaryGit(id)
  useMessageQueue.getState().clearQueue(id)
  useCoworkSessions.getState().deleteSession(id, opts)
  // The activity record is keyed by session; leaving it behind would keep a
  // deleted session's workflows in the store forever.
  useCoworkActivity.getState().dropSession(id)
  // The file record is keyed by session too; leaving it behind would keep a
  // deleted session's paths in storage indefinitely.
  useFileActivity.getState().forget(id)
  // Teardown, not completion: the session is gone, so nothing is left to hold
  // its authority in place. Its work items would otherwise keep a deleted
  // session marked busy for the life of the app session.
  useCoworkActiveWork.getState().clearSession(id)
  // The origin ledger describes a run whose transcript is about to be gone.
  useCoworkOrigins.getState().forget(id)
  // Other sessions can no longer reach it; mail to it becomes undeliverable.
  // An archive is not a delete: a tombstone would block registering the
  // session again after a restore.
  if (opts?.keepRecords) notifySessionArchived(id)
  else notifySessionRemoved(id)
  useSessionMessaging.getState().forget(id)
}

/**
 * Archive a Cowork session, then tear it down (a failed archive leaves the
 * session where it is). What is kept: the session itself, and the worktree
 * record, so a restore can find the branch again and a later purge can remove
 * it. Archiving never discards a worktree; `removeWorktree` only says the
 * purge should, and the purge refuses while the worktree holds unmerged work.
 * Its prompt snapshots and other records stay until the purge.
 *
 * Returns false when the archive is off, so the caller runs the old delete.
 */
export async function archiveCoworkSession(
  id: string,
  removeWorktree: boolean
): Promise<boolean> {
  if (!(await archiveEnabled())) return false
  const session = useCoworkSessions.getState().sessions.find((s) => s.id === id)
  if (!session) return false
  const worktree = useCoworkWorktrees.getState().bySession[id] ?? null
  await archiveApi.put(
    'cowork',
    id,
    session.title,
    { session },
    { worktree, discardOnPurge: removeWorktree && worktree !== null }
  )
  deleteCoworkSession(id, { keepRecords: true })
  return true
}

/** Put an archived Cowork session (and its worktree record) back. */
export function restoreCoworkSession(payload: unknown, extra: unknown): boolean {
  const session = (payload as { session?: CoworkSession } | null)?.session
  if (!session || typeof session.id !== 'string') return false
  const worktree = (extra as { worktree?: unknown } | null)?.worktree
  if (worktree && typeof worktree === 'object') {
    useCoworkWorktrees.setState((s) =>
      s.bySession[session.id]
        ? s
        : {
            bySession: {
              ...s.bySession,
              [session.id]: worktree as never,
            },
          }
    )
  }
  notifySessionRestored(session.id)
  return useCoworkSessions.getState().restoreSession(session)
}
