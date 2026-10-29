import { create } from 'zustand'
import { ThreadMessage } from '@janhq/core'
import { toast } from 'sonner'
import { getServiceHub } from '@/hooks/useServiceHub'
import { i18n } from '@/i18n/react-i18next-compat'
import {
  cancelPendingMessageWrites,
  schedulePersist,
} from '@/lib/messageWriteQueue'

type MessageState = {
  messages: Record<string, ThreadMessage[]>
  getMessages: (threadId: string) => ThreadMessage[]
  setMessages: (threadId: string, messages: ThreadMessage[]) => void
  addMessage: (message: ThreadMessage) => void
  updateMessage: (message: ThreadMessage) => void
  deleteMessage: (threadId: string, messageId: string) => void
  clearAllMessages: () => void
}

export const useMessages = create<MessageState>()((set, get) => ({
  messages: {},
  getMessages: (threadId) => {
    return get().messages[threadId] || []
  },
  setMessages: (threadId, messages) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [threadId]: messages,
      },
    }))
  },
  addMessage: (message) => {
    const newMessage = {
      ...message,
      created_at: message.created_at || Date.now(),
    }

    // Optimistically update state immediately for instant UI feedback
    set((state) => ({
      messages: {
        ...state.messages,
        [message.thread_id]: [
          ...(state.messages[message.thread_id] || []),
          newMessage,
        ],
      },
    }))

    // Persist to storage asynchronously. The echo only replaces the entry if
    // it is still the object added above: an updateMessage (error metadata,
    // branch relinking) made while the write was in flight is newer than the
    // echo and must not be reverted by it.
    getServiceHub().messages().createMessage(newMessage).then((createdMessage) => {
      set((state) => ({
        messages: {
          ...state.messages,
          [message.thread_id]:
            state.messages[message.thread_id]?.map((existing) =>
              existing === newMessage ? createdMessage : existing
            ) ?? [createdMessage],
        },
      }))
    }).catch((error) => {
      console.error('Failed to persist message:', error)
      toast.error(i18n.t('common:messageSaveFailed'))
    })
  },
  updateMessage: (message) => {
    const updatedMessage = {
      ...message,
    }

    // Optimistically update state immediately for instant UI feedback
    set((state) => ({
      messages: {
        ...state.messages,
        [message.thread_id]: (state.messages[message.thread_id] || []).map((m) =>
          m.id === message.id ? updatedMessage : m
        ),
      },
    }))

    // Persist with modifyMessage (not createMessage, which would duplicate),
    // debounced per message: a burst of updates costs one write.
    schedulePersist(updatedMessage)
  },
  deleteMessage: (threadId, messageId) => {
    const before = get().messages[threadId] ?? []
    const index = before.findIndex((message) => message.id === messageId)
    const removed = index >= 0 ? before[index] : undefined
    // A pending update written after the delete would bring the message back.
    cancelPendingMessageWrites(threadId, messageId)
    // Optimistic removal, as addMessage/updateMessage do.
    set((state) => ({
      messages: {
        ...state.messages,
        [threadId]:
          state.messages[threadId]?.filter(
            (message) => message.id !== messageId
          ) || [],
      },
    }))
    // The delete used to be fired unawaited with no handler: a failed backend
    // delete was an unhandled rejection and the message, still on disk,
    // reappeared on the next load (#80). Put it back where it was instead.
    // The executor runs now, so the backend call is made synchronously and a
    // synchronous throw is caught as well.
    new Promise<void>((resolve) =>
      resolve(getServiceHub().messages().deleteMessage(threadId, messageId))
    ).catch((error) => {
        console.error('Failed to delete message:', error)
        if (!removed) return
        set((state) => {
          const current = state.messages[threadId] ?? []
          if (current.some((message) => message.id === messageId)) return state
          const restored = [...current]
          restored.splice(Math.min(index, restored.length), 0, removed)
          return { messages: { ...state.messages, [threadId]: restored } }
        })
      })
  },
  clearAllMessages: () => {
    set({ messages: {} })
  },
}))
