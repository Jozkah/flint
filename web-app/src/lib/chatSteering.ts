import { lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from 'ai'
import type { QueuedMessage } from '@/stores/message-queue-store'

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
