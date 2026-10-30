import type { UIMessage } from 'ai'
import {
  ThreadMessage,
  MessageStatus,
  ChatCompletionRole,
} from '@janhq/core'
import { extractContentPartsFromUIMessage } from '@/lib/messages'
import { toMs } from '@/lib/messageTime'
import { computeActivePath } from '@/lib/message-branching'

/**
 * The user message an assistant reply in `messages` hangs off of: the user
 * turn at (or before) `messageId` on the active path, or the last one when
 * `messageId` is undefined.
 */
export function resolveAssistantParentIn(
  messages: ThreadMessage[],
  activeRootId: string | undefined,
  messageId: string | undefined
): string | null {
  const path = computeActivePath(messages, activeRootId)
  const idx =
    messageId == null
      ? path.length - 1
      : path.findIndex((m) => m.id === messageId)
  if (idx === -1) return null
  const sel = path[idx]
  if (sel.role === 'user') return sel.id
  for (let i = idx; i >= 0; i--) {
    if (path[i].role === 'user') return path[i].id
  }
  return null
}

/**
 * The ThreadMessage a finished (or interrupted) assistant reply is saved as.
 * The reply keeps the time it began with: every step of a tool turn finishes
 * into the same message, and each used to restamp it with the time that step
 * ended.
 */
export function buildAssistantThreadMessage({
  message,
  threadId,
  existing,
  metadata,
  parentId,
  now = Date.now(),
}: {
  message: UIMessage
  threadId: string
  /** The saved copy of this reply, if any. */
  existing: ThreadMessage | undefined
  metadata: Record<string, unknown>
  parentId: string | null
  now?: number
}): ThreadMessage {
  const repliedAt =
    existing?.created_at ||
    toMs(
      message.metadata &&
        (message.metadata as { createdAt?: unknown }).createdAt
    ) ||
    now
  return {
    type: 'text',
    role: ChatCompletionRole.Assistant,
    content: extractContentPartsFromUIMessage(message),
    id: message.id,
    object: 'thread.message',
    thread_id: threadId,
    status: MessageStatus.Ready,
    created_at: repliedAt,
    completed_at: now,
    metadata: parentId != null ? { ...metadata, parentId } : metadata,
  }
}
