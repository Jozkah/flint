import { useCallback } from 'react'
import { useMessages } from '@/hooks/useMessages'
import type { Dispatch, SetStateAction } from 'react'
import type { useAppState } from '@/hooks/useAppState'

/**
 * Clearing the conversation's banner errors (out of memory, backend, context
 * limit) and the metadata that brings them back. Lifted out of
 * ThreadConversation.tsx unchanged.
 */
export function useBannerErrors({
  threadId,
  updateMessage,
  oomError,
  setOomError,
  backendError,
  setBackendError,
  contextLimitError,
  setContextLimitError,
}: {
  threadId: string
  updateMessage: ReturnType<typeof useMessages.getState>['updateMessage']
  oomError: string | undefined
  setOomError: ReturnType<typeof useAppState.getState>['setOomError']
  backendError: string | undefined
  setBackendError: ReturnType<typeof useAppState.getState>['setBackendError']
  contextLimitError: Error | null
  setContextLimitError: Dispatch<SetStateAction<Error | null>>
}) {
  const stripBannerMetadata = useCallback(() => {
    const tmsgs = useMessages.getState().getMessages(threadId)
    for (const m of tmsgs) {
      const meta = m.metadata as Record<string, unknown> | undefined
      if (!meta) continue
      if (
        meta.oomError == null &&
        meta.backendError == null &&
        meta.contextError == null
      )
        continue
      const nextMeta = { ...meta }
      delete nextMeta.oomError
      delete nextMeta.backendError
      delete nextMeta.contextError
      updateMessage({ ...m, metadata: nextMeta })
    }
  }, [threadId, updateMessage])

  // Dismiss any active thread-level banner error and strip its persisted
  // metadata. The banner stands in for a failed last assistant turn (hidden by
  // the render filter), so leaving it set would blank a healthy assistant on
  // whatever branch we navigate to next.
  const clearBannerErrors = useCallback(() => {
    if (oomError) setOomError(undefined)
    if (backendError) setBackendError(undefined)
    if (contextLimitError) setContextLimitError(null)
    if (oomError || backendError || contextLimitError) stripBannerMetadata()
  // Same dependencies as in ThreadConversation: the refs and setters it hands in are stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    oomError,
    setOomError,
    backendError,
    setBackendError,
    contextLimitError,
    stripBannerMetadata,
  ])

  return { stripBannerMetadata, clearBannerErrors }
}
