import { lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from 'ai'
import {
  useMessageQueue,
  type QueuedMessage,
} from '@/stores/message-queue-store'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

/**
 * The chat's `sendAutomaticallyWhen`, with steering.
 *
 * The chat runs its tool loop in the client: each tool round ends with every
 * call of the last assistant message answered, and the SDK then asks whether
 * to send the next request. That moment is the chat's safe point. If the user
 * chose to steer with queued messages (Steer now, Ctrl+Enter), they are taken
 * and sent there as one user turn, in queue order, so the model's next request
 * carries the tool results and the new words together; the plain follow-up is
 * then not sent (returns false), since the steering request replaces it.
 *
 * Plain queued messages are never taken here: they wait for the run to end.
 */
/** The tool calls of the last assistant message, once every one has its result. */
export function finishedToolBatch(
  messages: UIMessage[]
): { key: string; names: string[] } | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return null
  // One assistant message holds every step of the tool loop; the batch is the
  // calls of the latest step, the ones after its last `step-start`.
  const parts = last.parts as Array<Record<string, unknown>>
  let from = 0
  parts.forEach((p, i) => {
    if (p.type === 'step-start') from = i + 1
  })
  const calls = parts.slice(from).filter((p) => {
    const type = String(p.type)
    return type === 'dynamic-tool' || type.startsWith('tool-')
  })
  if (calls.length === 0) return null
  return {
    key: `${last.id}:${calls.map((p) => String(p.toolCallId)).join(',')}`,
    names: calls.map((p) =>
      p.type === 'dynamic-tool' ? String(p.toolName) : String(p.type).slice(5)
    ),
  }
}

/** Retries already sent per message for a step that gave no reply. */
const noReplyRetries = new Map<string, number>()
/** Retries one message may get, so a model that keeps answering nothing stops. */
const MAX_NO_REPLY_RETRIES = 2

/**
 * The key of a last step that gave no reply: the model worked with tools (a
 * search that failed or was rate limited, say), then its latest step carried
 * no text, file or tool call -- reasoning alone ("let me search for both...")
 * or nothing at all. The run would end there with no answer; one more request
 * lets the model answer from what the tools returned.
 */
export function noReplyStep(messages: UIMessage[]): string | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return null
  const parts = last.parts as Array<Record<string, unknown>>
  let from = 0
  parts.forEach((p, i) => {
    if (p.type === 'step-start') from = i + 1
  })
  const isTool = (p: Record<string, unknown>) =>
    p.type === 'dynamic-tool' || String(p.type).startsWith('tool-')
  if (!parts.slice(0, from).some(isTool)) return null
  const acted = parts
    .slice(from)
    .some(
      (p) =>
        isTool(p) ||
        p.type === 'file' ||
        (p.type === 'text' && !!String(p.text ?? '').trim())
    )
  return acted ? null : `${last.id}:${from}`
}

export function chatFollowUp({
  messages,
  aborted,
  takeSteering,
  send,
  onBatchFinished,
}: {
  messages: UIMessage[]
  /** The run was stopped: nothing more goes, steering included. */
  aborted: boolean
  takeSteering: () => QueuedMessage[]
  send: (text: string) => void
  /**
   * Told once the turn's tool calls all have results, before the next request
   * (called each time the SDK asks, so the caller dedupes by `key`).
   */
  onBatchFinished?: (batch: { key: string; names: string[] }) => void
}): boolean {
  if (aborted) return false
  const noReply = noReplyStep(messages)
  if (noReply) {
    const id = noReply.slice(0, noReply.lastIndexOf(':'))
    const sent = noReplyRetries.get(id) ?? 0
    if (sent < MAX_NO_REPLY_RETRIES) {
      noReplyRetries.set(id, sent + 1)
      return true
    }
  }
  if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) return false
  const batch = finishedToolBatch(messages)
  if (batch) onBatchFinished?.(batch)
  const taken = takeSteering()
  if (taken.length === 0) return true
  send(taken.map((m) => m.text).join('\n\n'))
  return false
}

/**
 * A tool call waiting for approval blocks the loop, so it never reaches the
 * safe point where steering is handed over and Steer now would do nothing
 * until the user answered. Steering means "change course now": the waiting
 * prompts are withdrawn (answered no, recorded as cancelled, not as a denial)
 * and the loop moves on to the steering.
 */
export function withdrawApprovalsForSteering(threadId: string): void {
  if (!threadId) return
  useToolApprovalRequests.getState().clearPendingForThread(threadId)
}

/**
 * Stop, Chat and Cowork alike: hold what is queued for the given queues --
 * each message then offers Send and Discard -- and only then stop the run, so
 * the stopping run cannot take a steering message at a last safe point.
 * Nothing queued is cleared by Stop.
 */
export function holdQueueThenStop(queueIds: string[], stop: () => void): void {
  const queue = useMessageQueue.getState()
  for (const id of queueIds) if (id) queue.holdQueue(id)
  stop()
}

/**
 * What the chat sends once a run has ended (or failed): the next queued
 * message that is not held. Held messages -- typed for a run that failed or
 * was stopped -- wait for the user to Send or Discard them.
 *
 * Steering comes first. When the model answers without any tool call there is
 * no safe point for chatFollowUp to hand it over at, so the run ends with the
 * user's steer still waiting; it goes now, as the immediate next turn, marked
 * steered like a steer delivered mid-run -- never after other queued messages
 * and never unmarked.
 */
export function nextChatTurn(
  threadId: string
): { text: string; steered: boolean } | null {
  const queue = useMessageQueue.getState()
  const steering = queue.takeSteering(threadId)
  if (steering.length > 0) {
    return { text: steering.map((m) => m.text).join('\n\n'), steered: true }
  }
  const next = queue.dequeueReady(threadId)
  return next ? { text: next.text, steered: false } : null
}

/**
 * Stop for a chat turn: Stop on a running tool call stops everything. The
 * tool is cancelled (by the stream's own stop) and the turn's tool loop is
 * aborted, so the cancelled result is never sent back for another reply.
 */
export function stopChatTurn({
  toolAbort,
  stopDelegation,
  stopStream,
  cancelToolCall,
}: {
  toolAbort: { current: AbortController | null }
  stopDelegation: () => void
  stopStream: () => void
  /** Cancels the MCP call in flight at the server, now rather than at its timeout. */
  cancelToolCall?: () => void
}): void {
  cancelToolCall?.()
  toolAbort.current?.abort()
  stopDelegation()
  stopStream()
}
