import { useEffect } from 'react'
import { useMessages } from '@/hooks/useMessages'
import { stampContextErrorOnThread } from '@/lib/chat/threadHelpers'
import { useMessageErrors } from '@/stores/message-errors'
import type { useChat } from '@/hooks/use-chat'
import { describeChatFailure } from '@/lib/endpointDiagnostics'
import type { UIMessage } from '@ai-sdk/react'
import { isContextOverflowMessage } from '@/utils/error'
import type { Dispatch, SetStateAction } from 'react'

/**
 * Puts a stream error on the turn it belongs to (or on the context banner),
 * and keeps recorded errors on the stored messages. Returns the stored
 * messages it watches. Lifted out of ThreadConversation.tsx unchanged.
 */
export function useErrorStamping({
  threadId,
  status,
  error,
  chatMessages,
  updateMessage,
  selectedProvider,
  setContextLimitError,
}: {
  threadId: string
  status: ReturnType<typeof useChat>['status']
  error: ReturnType<typeof useChat>['error']
  chatMessages: UIMessage[]
  updateMessage: ReturnType<typeof useMessages.getState>['updateMessage']
  selectedProvider: string
  setContextLimitError: Dispatch<SetStateAction<Error | null>>
}) {
  // Attach the error to the assistant turn it belongs to so the banner renders
  // alongside any tool-call parts the model already produced. Falls back to the
  // last user message if no assistant message exists yet (e.g. provider 4xx
  // before streaming starts).
  useEffect(() => {
    if (!error) return
    let targetId: string | undefined
    let lastUserIdx = -1
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    for (let i = chatMessages.length - 1; i > lastUserIdx; i--) {
      if (chatMessages[i].role === 'assistant') {
        targetId = chatMessages[i].id
        break
      }
    }
    if (!targetId && lastUserIdx >= 0) {
      targetId = chatMessages[lastUserIdx].id
    }
    if (!targetId) return
    const errMessage =
      error instanceof Error
        ? describeChatFailure(error, selectedProvider)
        : String(error || 'Error')
    // Context overflow is owned by the global "Increase Context Size" banner;
    // a per-message Regenerate would just re-overflow the same prompt.
    if (isContextOverflowMessage(errMessage)) {
      stampContextErrorOnThread(threadId, errMessage)
      setContextLimitError(new Error(errMessage))
      useMessageErrors.getState().clearError(targetId)
      return
    }
    useMessageErrors.getState().setError(targetId, errMessage)
    const tm = useMessages.getState().getMessages(threadId).find(
      (m) => m.id === targetId
    )
    if (tm) {
      const existingError = (tm.metadata as Record<string, unknown> | undefined)
        ?.error
      if (existingError !== errMessage) {
        updateMessage({
          ...tm,
          metadata: { ...(tm.metadata || {}), error: errMessage },
        })
      }
    }
  // Same dependencies as in ThreadConversation: the refs and setters it hands in are stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, error, threadId, chatMessages, updateMessage, selectedProvider])

  // Persist whenever the user message lands in useMessages — covers the race
  // where the stamping effect ran before addMessage's commit was observable.
  const localThreadMessages = useMessages((s) => s.messages?.[threadId])
  const errorEntries = useMessageErrors((s) => s.errors)
  useEffect(() => {
    if (!localThreadMessages) return
    for (const m of localThreadMessages) {
      const err = errorEntries[m.id]
      if (typeof err !== 'string' || !err) continue
      const existing = (m.metadata as Record<string, unknown> | undefined)
        ?.error
      if (existing === err) continue
      updateMessage({
        ...m,
        metadata: { ...(m.metadata || {}), error: err },
      })
    }
  }, [localThreadMessages, errorEntries, updateMessage])

  return localThreadMessages
}
