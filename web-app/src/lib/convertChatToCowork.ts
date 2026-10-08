import type { ThreadMessage } from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { messagesToFork } from '@/lib/forkThread'
import type { CoworkTurn } from '@/types/coworkSession'

/**
 * Turn a chat into a Cowork session: the shown branch becomes the session's
 * transcript, as plain user and assistant turns. Reasoning and tool calls stay
 * with the chat; the session starts unbound (no folder, no access), like a fork.
 */

/** The user and assistant turns of a chat's shown branch. Empty rows are dropped. */
export function chatToTurns(messages: readonly ThreadMessage[]): CoworkTurn[] {
  const turns: CoworkTurn[] = []
  for (const m of messagesToFork(messages)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const texts: string[] = []
    const images: string[] = []
    for (const part of m.content ?? []) {
      if (part.type === 'text' && part.text?.value) texts.push(part.text.value)
      else if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:'))
        images.push(part.image_url.url)
    }
    const content = texts.join('\n\n')
    if (!content && images.length === 0) continue
    turns.push({
      role: m.role,
      content,
      ...(m.role === 'user' && images.length ? { images } : {}),
    })
  }
  return turns
}

/**
 * Returns the new session's id, or `null` when the chat has nothing to carry
 * over (a temporary chat, an unknown thread, no text).
 */
export async function convertChatToCowork(
  threadId: string,
  loadMessages: (id: string) => Promise<ThreadMessage[]>
): Promise<string | null> {
  if (threadId === TEMPORARY_CHAT_ID) return null
  const thread = useThreads.getState().threads[threadId]
  if (!thread) return null

  let stored = useMessages.getState().getMessages(threadId)
  if (stored.length === 0) stored = await loadMessages(threadId)

  const turns = chatToTurns(stored)
  if (turns.length === 0) return null
  return useCoworkSessions.getState().createFromTurns(thread.title ?? '', turns)
}
