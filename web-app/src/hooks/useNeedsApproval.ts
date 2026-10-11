import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useCoworkRun } from '@/hooks/useCoworkRun'

/**
 * Whether a conversation (a chat thread or a Cowork session, by id) is
 * waiting on the person: a permission prompt, a plan or an ask card. The one
 * signal the split tabs and the sidebar rows read, so they cannot disagree.
 */
export function useNeedsApproval(id: string | undefined): boolean {
  const approval = useToolApprovalRequests((s) =>
    id
      ? Object.values(s.pending ?? {}).some((p) => p.threadId === id)
      : false
  )
  const ask = useCoworkRun((s) =>
    id ? (s.pendingAsks?.[id]?.length ?? 0) > 0 : false
  )
  return approval || ask
}
