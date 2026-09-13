import { useEffect } from 'react'
import { useThreads } from '@/hooks/useThreads'
import { chatMemoryBinding, type MemoryBinding } from '@/lib/memoryBinding'

/**
 * Keep a chat transport bound to its thread's project and temporary state.
 *
 * Runs when the session is created and whenever the thread's project changes
 * -- moved to another project, removed from one, or the project deleted (which
 * clears it on every thread). The transport also re-reads the thread at send
 * time, so a change made while this chat is not on screen still applies; this
 * hook is what makes the binding current for the context panel immediately.
 * A request already running keeps the memory it retrieved either way.
 */
export function useChatMemoryBinding(
  sessionId: string | undefined,
  transport: { setMemoryBinding(binding: MemoryBinding): void } | undefined
): void {
  const projectId = useThreads((s) =>
    sessionId ? s.threads[sessionId]?.metadata?.project?.id : undefined
  )
  const projectName = useThreads((s) =>
    sessionId ? s.threads[sessionId]?.metadata?.project?.name : undefined
  )

  useEffect(() => {
    if (!transport) return
    transport.setMemoryBinding(
      chatMemoryBinding(
        sessionId,
        projectId
          ? { metadata: { project: { id: projectId, name: projectName } } }
          : undefined
      )
    )
  }, [transport, sessionId, projectId, projectName])
}
