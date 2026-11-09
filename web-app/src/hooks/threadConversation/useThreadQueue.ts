import { sendQueuedViaComposer } from '@/lib/remote/queuedSend'
import { useEffect, useRef } from 'react'
import type { useChat } from '@/hooks/use-chat'
import { nextChatTurn } from '@/lib/chatSteering'
import { useMessageQueue } from '@/stores/message-queue-store'
import type { useChatSessions } from '@/stores/chat-session-store'

/**
 * The chat's message queue: held when the stream errors, and the next queued
 * or steered message sent once the chat is ready and its tools have settled.
 * Lifted out of ThreadConversation.tsx unchanged, in the same hook order.
 */
export function useThreadQueue({
  threadId,
  status,
  threadBusy,
  sessionData,
  sendQueuedMessage,
}: {
  threadId: string
  status: ReturnType<typeof useChat>['status']
  threadBusy: boolean
  sessionData: ReturnType<ReturnType<typeof useChatSessions.getState>['getSessionData']>
  sendQueuedMessage: (text: string, steered?: boolean) => Promise<void>
}) {
  // Message queue: auto-send the next queued message when the stream finishes.
  // No reactive subscription to the queue here — ChatInput owns the UI.
  // We only read the store imperatively when status transitions to 'ready'.
  const processingQueueRef = useRef(false)

  // If streaming errors out, hold what is queued -- the way Cowork does -- for
  // the user to send or discard: it was typed for a run that failed, and
  // neither dropping it nor sending it on its own is right. Declared before the
  // sender below so the hold lands first in the same commit.
  useEffect(() => {
    if (status === 'error') {
      useMessageQueue.getState().holdQueue(threadId)
    }
  }, [status, threadId])

  // Released (Send on a held chip) or newly queued messages. Read so the
  // sender below runs when the user releases one after an error, when the
  // status does not change.
  // Counted only while the chat can send: a message queued or steered during
  // a run must not re-render this whole conversation just to bump a number
  // the sender below ignores until the run ends.
  const canSendQueued = status === 'ready' || status === 'error'
  const readyQueued = useMessageQueue((s) =>
    canSendQueued ? s.getQueue(threadId).filter((m) => !m.held).length : 0
  )

  useEffect(() => {
    if (status !== 'ready' && status !== 'error') return
    if (processingQueueRef.current) return
    if (threadBusy || sessionData.tools.length > 0) return

    const next = nextChatTurn(threadId)
    if (!next) return

    processingQueueRef.current = true
    // A phone's message queued with attachments goes through this chat's
    // composer entry, as a phone's send to an idle chat does, so its media
    // and documents go with it. This view registers that entry, so the
    // text-only fallback is only for a send racing an unmount.
    const { attachments } = next
    const sending = attachments
      ? sendQueuedViaComposer('chat', threadId, next.text, attachments).then(
          (sent) => (sent ? undefined : sendQueuedMessage(next.text, false))
        )
      : sendQueuedMessage(next.text, next.steered)
    sending
      .catch((err) => {
        console.error('Failed to send queued message:', err)
      })
      .finally(() => {
        processingQueueRef.current = false
      })
  }, [
    status,
    threadId,
    sendQueuedMessage,
    sessionData.tools.length,
    threadBusy,
    readyQueued,
  ])
}
