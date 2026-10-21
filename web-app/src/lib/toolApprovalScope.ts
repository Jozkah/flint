import type { PendingApproval } from '@/hooks/useToolApprovalRequests'

/**
 * The approval request a tool card should show for its call id.
 *
 * Providers that number calls per response (and local models with short ids)
 * reuse a call id across chats, and the store keeps one head per id with the
 * rest queued behind it. A card drawn in thread B must not offer the controls
 * of thread A's request that happens to hold the same id: answering would
 * answer the wrong chat's call. Given the thread the card belongs to, only a
 * request owned by that thread qualifies, the head first, then the queue.
 * With no thread (outside the chat view) the head is returned as before.
 */
export function approvalForCall(
  state: {
    pending: Record<string, PendingApproval>
    queued?: Record<string, PendingApproval[]>
  },
  toolCallId: string | undefined,
  threadId: string | undefined
): PendingApproval | undefined {
  if (!toolCallId) return undefined
  const head = state.pending[toolCallId]
  if (!threadId) return head
  if (head?.threadId === threadId) return head
  return state.queued?.[toolCallId]?.find((e) => e.threadId === threadId)
}
