import { useMemo } from 'react'
import type { ThreadMessage } from '@janhq/core'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { activePathOf } from '@/lib/message-branching'

const NONE: ThreadMessage[] = []

/**
 * The messages of the conversation on screen: the active path through the
 * thread's versions, not the stored list that also holds the edited and
 * regenerated ones. Token counts, the context meter and similar readers use
 * this so a replaced reply is not counted twice.
 */
export function useActiveMessages(threadId: string | undefined | null) {
  const stored = useMessages((s) => (threadId ? s.messages?.[threadId] : undefined))
  const metadata = useThreads(
    (s) => (threadId ? s.threads?.[threadId]?.metadata : undefined)
  )
  return useMemo(
    () => (stored ? activePathOf(stored, metadata) : NONE),
    [stored, metadata]
  )
}

/** The same, read once (for event handlers and non-React code). */
export function getActiveMessages(threadId: string): ThreadMessage[] {
  return activePathOf(
    useMessages.getState().getMessages(threadId),
    useThreads.getState().threads[threadId]?.metadata
  )
}
