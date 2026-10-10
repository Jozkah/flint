import { useThreads } from '@/hooks/useThreads'

/** Flag a thread as holding documents without dropping its other metadata. */
export function markThreadHasDocuments(threadId: string) {
  const thread = useThreads.getState().threads[threadId]
  useThreads.getState().updateThread(threadId, {
    metadata: { ...thread?.metadata, hasDocuments: true },
  })
}
