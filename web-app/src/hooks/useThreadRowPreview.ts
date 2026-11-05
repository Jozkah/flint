import { useEffect, useMemo, useRef, useState } from 'react'
import type { ThreadMessage } from '@janhq/core'
import { useMessages } from '@/hooks/useMessages'
import { useServiceHub } from '@/hooks/useServiceHub'

/** The last thing the user asked in a chat, for a collection page row. Only the
 * project page shows it, so only there are transcripts loaded. */
export function useThreadRowPreview(
  threadId: string,
  currentProjectId: string | undefined
): string | undefined {
  const serviceHub = useServiceHub()
  const getMessages = useMessages((state) => state.getMessages)
  const setMessages = useMessages((state) => state.setMessages)

  // Use a ref to track if messages have been loaded
  const messagesLoadedRef = useRef(false)
  // Track current messages for comparison
  const messagesLengthRef = useRef(0)

  // Get messages reactively via ref tracking (to avoid infinite re-renders)
  const [messages, setLocalMessages] = useState<ThreadMessage[]>(() =>
    getMessages(threadId)
  )

  // Fetch messages if not loaded yet. Only the project page shows a message
  // preview; the sidebar never loads transcripts just to render a row.
  useEffect(() => {
    if (!currentProjectId) return
    const currentMessages = getMessages(threadId)

    // Initial load: no messages yet, fetch them
    if (currentMessages.length === 0 && !messagesLoadedRef.current) {
      messagesLoadedRef.current = true
      serviceHub
        .messages()
        .fetchMessages(threadId)
        .then((fetchedMessages) => {
          // Only overwrite if the disk actually has content. A brand-new
          // thread starts empty on disk, and racing this against the
          // optimistic addMessage write was wiping the user message.
          if (fetchedMessages && fetchedMessages.length > 0) {
            setMessages(threadId, fetchedMessages)
            setLocalMessages(fetchedMessages)
            messagesLengthRef.current = fetchedMessages.length
          }
        })
        .catch(() => {
          messagesLoadedRef.current = false
        })
      return
    }

    // Only update local state if messages length changed (prevents re-renders during streaming)
    if (currentMessages.length !== messagesLengthRef.current) {
      setLocalMessages(currentMessages)
      messagesLengthRef.current = currentMessages.length
    }
  }, [threadId, currentProjectId, serviceHub, getMessages, setMessages])

  const lastUserMessageText = useMemo(() => {
    const userMessages = messages.filter((m) => m.role === 'user')
    const lastUserMessage = userMessages[userMessages.length - 1]
    if (!lastUserMessage) return undefined
    const textContent = lastUserMessage.content?.find((c) => c.type === 'text')
    return textContent?.text?.value
  }, [messages])

  return lastUserMessageText
}
