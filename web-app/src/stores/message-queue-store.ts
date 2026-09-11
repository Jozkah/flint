import { create } from 'zustand'

export type QueuedMessage = {
  id: string
  text: string
  createdAt: number
  /**
   * Not to be sent until the user says so: the run it was typed for failed or
   * was stopped, or the app restarted before it was delivered. Shown, never
   * dropped and never sent on its own. janhq/jan#8864.
   */
  held?: boolean
}

// Stable reference for empty queues so selectors don't trigger unnecessary re-renders
const EMPTY_QUEUE: QueuedMessage[] = []

interface MessageQueueState {
  // Per-thread message queues
  queues: Record<string, QueuedMessage[]>

  enqueue: (threadId: string, message: QueuedMessage) => void
  dequeue: (threadId: string) => QueuedMessage | undefined
  removeMessage: (threadId: string, messageId: string) => void
  clearQueue: (threadId: string) => void
  getQueue: (threadId: string) => QueuedMessage[]
  /** Remove and return every message that is not held, in order. */
  takeReady: (threadId: string) => QueuedMessage[]
  /** Remove and return the first message that is not held. */
  dequeueReady: (threadId: string) => QueuedMessage | undefined
  /** Mark every queued message held. */
  holdQueue: (threadId: string) => void
  /** Let one held message be sent. */
  release: (threadId: string, messageId: string) => void
  /** Put messages back after a restart, held; ids already queued are skipped. */
  restoreHeld: (threadId: string, messages: QueuedMessage[]) => void
}

export const useMessageQueue = create<MessageQueueState>((set, get) => ({
  queues: {},

  enqueue: (threadId, message) => {
    set((state) => ({
      queues: {
        ...state.queues,
        [threadId]: [...(state.queues[threadId] ?? []), message],
      },
    }))
  },

  // Atomically removes and returns the first message from the queue.
  // The entire read-and-mutate happens inside set() to avoid stale-closure races.
  dequeue: (threadId) => {
    let first: QueuedMessage | undefined
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue || queue.length === 0) return state
      const [head, ...rest] = queue
      first = head
      return { queues: { ...state.queues, [threadId]: rest } }
    })
    return first
  },

  removeMessage: (threadId, messageId) => {
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue) return state
      const filtered = queue.filter((m) => m.id !== messageId)
      if (filtered.length === queue.length) return state
      return { queues: { ...state.queues, [threadId]: filtered } }
    })
  },

  clearQueue: (threadId) => {
    set((state) => {
      if (!state.queues[threadId]?.length) return state
      const updated = { ...state.queues }
      delete updated[threadId]
      return { queues: updated }
    })
  },

  getQueue: (threadId) => {
    return get().queues[threadId] ?? EMPTY_QUEUE
  },

  takeReady: (threadId) => {
    let taken: QueuedMessage[] = []
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue?.some((m) => !m.held)) return state
      taken = queue.filter((m) => !m.held)
      return {
        queues: { ...state.queues, [threadId]: queue.filter((m) => m.held) },
      }
    })
    return taken
  },

  dequeueReady: (threadId) => {
    let first: QueuedMessage | undefined
    set((state) => {
      const queue = state.queues[threadId]
      const index = queue?.findIndex((m) => !m.held) ?? -1
      if (!queue || index < 0) return state
      first = queue[index]
      return {
        queues: {
          ...state.queues,
          [threadId]: queue.filter((_, i) => i !== index),
        },
      }
    })
    return first
  },

  holdQueue: (threadId) => {
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue?.some((m) => !m.held)) return state
      return {
        queues: {
          ...state.queues,
          [threadId]: queue.map((m) => ({ ...m, held: true })),
        },
      }
    })
  },

  release: (threadId, messageId) => {
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue?.some((m) => m.id === messageId && m.held)) return state
      return {
        queues: {
          ...state.queues,
          [threadId]: queue.map((m) =>
            m.id === messageId ? { ...m, held: false } : m
          ),
        },
      }
    })
  },

  restoreHeld: (threadId, messages) => {
    set((state) => {
      const queue = state.queues[threadId] ?? []
      const known = new Set(queue.map((m) => m.id))
      const added = messages
        .filter((m) => !known.has(m.id))
        .map((m) => ({ ...m, held: true }))
      if (added.length === 0) return state
      return { queues: { ...state.queues, [threadId]: [...queue, ...added] } }
    })
  },
}))
