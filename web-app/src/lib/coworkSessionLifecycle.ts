import { abortRun } from '@/lib/coworkRunner'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { useCoworkActiveWork } from '@/hooks/useCoworkActiveWork'
import { useCoworkOrigins } from '@/hooks/useCoworkOrigins'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useMessageQueue } from '@/stores/message-queue-store'

/**
 * Delete a Cowork session, stopping its run first (janhq/jan#8905).
 *
 * Deleting a session that was running used to leave its run streaming into a
 * session that no longer existed, with its questions and approvals still
 * pending. Now the run is stopped -- that run only; other sessions keep
 * theirs -- and everything held for the session is dropped, so a late event
 * from the stopped run finds nothing to write to and is refused.
 */
export function deleteCoworkSession(id: string): void {
  // The model stream, the tool loop, every subagent and any open question.
  abortRun(id, 'deleted')
  useCoworkRun.getState().forgetSession(id)
  useToolApprovalRequests.getState().clearPendingForThread(id)
  useMessageQueue.getState().clearQueue(id)
  useCoworkSessions.getState().deleteSession(id)
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
}
