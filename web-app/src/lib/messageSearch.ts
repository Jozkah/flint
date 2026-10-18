import { invoke } from '@tauri-apps/api/core'

/** Where a phrase was said, as the backend scan reports it. */
export type MessageHit = {
  threadId: string
  threadTitle: string
  messageId: string
  role: 'user' | 'assistant' | string
  snippet: string
  updated: number
}

export const MESSAGE_SEARCH_MIN_CHARS = 2
export const MESSAGE_SEARCH_LIMIT = 30

/**
 * Full-text search across every chat's messages. Resolves to nothing outside
 * the desktop app (there is no local message store to scan) and on any
 * failure: the title search next to it must keep working.
 */
export async function searchMessages(
  query: string,
  limit = MESSAGE_SEARCH_LIMIT
): Promise<MessageHit[]> {
  const q = query.trim()
  if (q.length < MESSAGE_SEARCH_MIN_CHARS) return []
  if (typeof IS_TAURI === 'undefined' || !IS_TAURI) return []
  try {
    return await invoke<MessageHit[]>('search_messages', { query: q, limit })
  } catch (error) {
    console.error('Message search failed:', error)
    return []
  }
}
