import { lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from 'ai'
import {
  useMessageQueue,
  type QueuedMessage,
} from '@/stores/message-queue-store'

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
export function chatFollowUp({
  messages,
  aborted,
  takeSteering,
  send,
}: {
  messages: UIMessage[]
  /** The run was stopped: nothing more goes, steering included. */
  aborted: boolean
  takeSteering: () => QueuedMessage[]
  send: (text: string) => void
}): boolean {
  if (aborted) return false
  if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) return false
  const taken = takeSteering()
  if (taken.length === 0) return true
  send(taken.map((m) => m.text).join('\n\n'))
  return false
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
