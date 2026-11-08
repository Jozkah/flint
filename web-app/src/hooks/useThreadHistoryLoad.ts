import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { UIMessage, UseChatHelpers } from '@ai-sdk/react'
import type { ServiceHub } from '@/services'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { useChatSessions } from '@/stores/chat-session-store'
import { useMessageErrors } from '@/stores/message-errors'
import { loadThreadMessages } from '@/lib/threadPrefetch'
import {
  convertThreadMessagesToUIMessages,
  threadMessageIsEmpty,
} from '@/lib/messages'
import {
  computeActivePath,
  repairDanglingParents,
  repairDetachedAssistants,
  removeFromTree,
} from '@/lib/message-branching'

type MessagesState = ReturnType<typeof useMessages.getState>

export type HistoryReadError = { threadId: string; message: string }

/**
 * Reads a Chat conversation's saved history into the store and the live
 * transcript the first time it is shown (and again on each retry), repairing
 * the damage older builds left in it. Lifted out of ThreadConversation.tsx
 * unchanged; the state it reports into stays with the conversation.
 */
export function useThreadHistoryLoad({
  threadId,
  serviceHub,
  historyReadAttempt,
  currentThread,
  setIsReadingHistory,
  setHistoryReadError,
  setMessages,
  updateMessage,
  deleteMessage,
  setChatMessages,
}: {
  threadId: string
  serviceHub: ServiceHub
  historyReadAttempt: number
  /** The thread whose history is already loaded into the transcript. */
  currentThread: MutableRefObject<string | undefined>
  setIsReadingHistory: Dispatch<SetStateAction<boolean>>
  setHistoryReadError: Dispatch<SetStateAction<HistoryReadError | null>>
  setMessages: MessagesState['setMessages']
  updateMessage: MessagesState['updateMessage']
  deleteMessage: MessagesState['deleteMessage']
  setChatMessages: UseChatHelpers<UIMessage>['setMessages']
}): void {
  // Load messages on first mount
  useEffect(() => {
    // Skip if chat already has messages (e.g., returning to a streaming conversation)
    const existingSession = useChatSessions.getState().sessions[threadId]
    if (
      existingSession?.chat.messages.length > 0 ||
      existingSession?.isStreaming ||
      currentThread.current === threadId
    ) {
      return
    }

    // The read may already have started when the pointer reached the row.
    let cancelled = false
    setIsReadingHistory(true)
    loadThreadMessages(threadId, (id) => serviceHub.messages().fetchMessages(id))
      .then((fetched) => {
        if (cancelled) return
        setHistoryReadError(null)
        // A chat opened straight after it was made (a continued chat's summary
        // seed) may not be on disk yet: its messages are only in the store, and
        // the model must still be sent them.
        const localNow = useMessages.getState().getMessages(threadId)
        const fetchedMessages =
          fetched && fetched.length > 0 ? fetched : (localNow ?? [])
        if (fetchedMessages.length > 0) {
          const currentLocalMessages = localNow

          let messagesToSet = fetchedMessages

          // Merge with local-only messages if needed
          if (currentLocalMessages && currentLocalMessages.length > 0) {
            const fetchedIds = new Set(fetchedMessages.map((m) => m.id))
            const localOnlyMessages = currentLocalMessages.filter(
              (m) => !fetchedIds.has(m.id)
            )

            if (localOnlyMessages.length > 0) {
              messagesToSet = [...fetchedMessages, ...localOnlyMessages].sort(
                (a, b) => (a.created_at || 0) - (b.created_at || 0)
              )
            }
          }

          // Drop and delete any persisted empty assistant rows produced by
          // the old bug where errored generations were written as empty-text
          // messages. Lossless cleanup — these carry no information.
          const emptyAssistantIds = messagesToSet
            .filter(threadMessageIsEmpty)
            .map((m) => m.id)
          const emptySet = new Set(emptyAssistantIds)
          if (emptyAssistantIds.length > 0) {
            // A user turn sent after an errored generation hangs off the empty
            // row; re-link it before the row goes, or the rest of the
            // conversation goes with it (janhq/jan#8495).
            const relinked = removeFromTree(messagesToSet, emptyAssistantIds)
            if (relinked.length > 0) {
              const byId = new Map(relinked.map((m) => [m.id, m]))
              messagesToSet = messagesToSet.map((m) => byId.get(m.id) ?? m)
              for (const m of relinked) updateMessage(m)
            }
            messagesToSet = messagesToSet.filter(
              (m) => !emptySet.has(m.id)
            )
            for (const id of emptyAssistantIds) {
              deleteMessage(threadId, id)
            }
          }

          // Migrate threads corrupted by the pre-#8357 bug: assistant replies
          // saved with parentId:null are phantom roots that computeActivePath
          // drops. Re-parent them to the user turn they answer and persist.
          const repaired = repairDetachedAssistants(messagesToSet)
          if (repaired.length > 0) {
            const byId = new Map(repaired.map((m) => [m.id, m]))
            messagesToSet = messagesToSet.map((m) => byId.get(m.id) ?? m)
            for (const m of repaired) updateMessage(m)
          }

          // Threads already damaged by the old delete path: messages whose
          // parent is gone are unreachable and render as missing replies.
          const reattached = repairDanglingParents(messagesToSet)
          if (reattached.length > 0) {
            const byId = new Map(reattached.map((m) => [m.id, m]))
            messagesToSet = messagesToSet.map((m) => byId.get(m.id) ?? m)
            for (const m of reattached) updateMessage(m)
          }

          setMessages(threadId, messagesToSet)

          const hydrated: Record<string, string> = {}
          for (const m of messagesToSet) {
            const err = (m.metadata as Record<string, unknown> | undefined)
              ?.error
            if (typeof err === 'string' && err.length > 0) {
              hydrated[m.id] = err
            }
          }
          useMessageErrors.getState().hydrate(hydrated)

          const activeRootId = (
            useThreads.getState().threads[threadId]?.metadata as
              | Record<string, unknown>
              | undefined
          )?.activeRootId as string | undefined
          const uiMessages = convertThreadMessagesToUIMessages(
            computeActivePath(messagesToSet, activeRootId)
          )
          setChatMessages(uiMessages)
          currentThread.current = threadId
        }
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Failed to fetch messages for thread:', threadId, error)
        setHistoryReadError({
          threadId,
          message:
            error instanceof Error
              ? error.message || 'History could not be read'
              : String(error),
        })
      })
      .finally(() => {
        if (!cancelled) setIsReadingHistory(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, serviceHub, historyReadAttempt])
}
