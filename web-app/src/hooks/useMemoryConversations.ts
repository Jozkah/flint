import { useMemo } from 'react'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useThreads } from '@/hooks/useThreads'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

export type MemoryConversation = {
  id: string
  title: string
  kind: 'chat' | 'cowork'
}

/**
 * The conversations and project folders memory can be scoped to.
 *
 * Session memory is keyed by the conversation's own id -- a Chat thread id or
 * a Cowork session id -- and project memory by the attached folder, so these
 * are the only things the memory page can meaningfully ask about. A temporary
 * chat is left out: it neither reads nor records memory.
 */
export function useMemoryConversations(): {
  sessions: MemoryConversation[]
  projects: string[]
} {
  const coworkSessions = useCoworkSessions((s) => s.sessions)
  const threads = useThreads((s) => s.threads)
  return useMemo(() => {
    const sessions: MemoryConversation[] = [
      ...coworkSessions.map((s) => ({
        id: s.id,
        title: s.title || 'Untitled session',
        kind: 'cowork' as const,
        updated: s.updated ?? 0,
      })),
      ...Object.values(threads ?? {})
        .filter((t) => t && t.id !== TEMPORARY_CHAT_ID)
        .map((t) => ({
          id: t.id,
          title: t.title || 'Untitled chat',
          kind: 'chat' as const,
          updated: Number(t.updated ?? 0),
        })),
    ]
      .sort((a, b) => b.updated - a.updated)
      .map(({ id, title, kind }) => ({ id, title, kind }))
    const projects = [
      ...new Set(
        coworkSessions
          .map((s) => s.folder)
          .filter((f): f is string => typeof f === 'string' && f.length > 0)
      ),
    ]
    return { sessions, projects }
  }, [coworkSessions, threads])
}
