import type { ThreadMessage } from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useMessages } from '@/hooks/useMessages'
import { useChatSessions } from '@/stores/chat-session-store'

/**
 * Read a chat's messages from disk before it is opened.
 *
 * Opening a chat you have not looked at yet waited for that read, then for the
 * history to be drawn. The read starts now, when the pointer reaches the row,
 * so by the click it is usually done. What the pointer never reaches is read
 * exactly as before.
 */
const FRESH_MS = 30_000

type Fetch = (threadId: string) => Promise<ThreadMessage[]>

const pending = new Map<string, { at: number; promise: Promise<ThreadMessage[]> }>()

const alreadyLoaded = (threadId: string): boolean =>
  useMessages.getState().getMessages(threadId).length > 0 ||
  (useChatSessions.getState().sessions[threadId]?.chat.messages.length ?? 0) > 0

/** Start reading a chat's messages, unless they are here or already being read. */
export function prefetchThreadMessages(threadId: string, fetch: Fetch): void {
  if (!threadId || threadId === TEMPORARY_CHAT_ID || alreadyLoaded(threadId)) return
  const hit = pending.get(threadId)
  if (hit && Date.now() - hit.at < FRESH_MS) return
  const promise = fetch(threadId)
  promise.catch(() => pending.delete(threadId))
  pending.set(threadId, { at: Date.now(), promise })
}

/**
 * The messages of a chat being opened: the read started on hover if there is
 * one, else a fresh read. A failed prefetch falls back to a fresh read.
 */
export function loadThreadMessages(
  threadId: string,
  fetch: Fetch
): Promise<ThreadMessage[]> {
  const hit = pending.get(threadId)
  pending.delete(threadId)
  if (hit && Date.now() - hit.at < FRESH_MS) {
    return hit.promise.catch(() => fetch(threadId))
  }
  return fetch(threadId)
}
