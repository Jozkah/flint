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
  /**
   * The user asked for this message to be handed to the running turn at its
   * next safe point (steering) instead of waiting for the run to end and
   * going as a new turn. Mail from another session is always steering.
   */
  steer?: boolean
  /**
   * Set when the message is mail from another agent session
   * (docs/SESSION_MESSAGING.md). `text` is then the wrapped text the model is
   * given; this records who sent it so the UI can attribute it and reply.
   */
  from?: QueuedMessageSender
}

export type QueuedMessageSender = {
  sessionId: string
  displayName: string
  messageId: string
  replyTo?: string | null
  depth: number
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
  /** Hold one message that was ready. */
  hold: (threadId: string, messageId: string) => void
  /** Put messages back after a restart, held; ids already queued are skipped. */
  restoreHeld: (threadId: string, messages: QueuedMessage[]) => void
  /** Mark one waiting message to be delivered into the running turn. */
  steerNow: (threadId: string, messageId: string) => void
  /**
   * Remove and return what the running turn should take at a safe point:
   * ready messages marked to steer, and mail. Plain queued messages stay to
   * go as new turns once the run ends.
   */
  takeSteering: (threadId: string) => QueuedMessage[]
  /** Move one message up (-1) or down (+1) in its queue. */
  move: (threadId: string, messageId: string, delta: number) => void
  /**
   * Put one message where another is (drag and drop): the dragged message
   * takes the target's place and the ones between shift by one.
   */
  reorder: (threadId: string, messageId: string, overId: string) => void
}

/** What the running turn takes at a safe point. */
export const isSteering = (m: QueuedMessage): boolean =>
  !m.held && (m.steer === true || !!m.from)

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
          // A held message waits for the user; releasing it later sends it
          // as a turn of its own, not as steering for a run it missed.
          [threadId]: queue.map((m) => ({
            ...m,
            steer: undefined,
            held: true,
          })),
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

  hold: (threadId, messageId) => {
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue?.some((m) => m.id === messageId && !m.held)) return state
      return {
        queues: {
          ...state.queues,
          [threadId]: queue.map((m) =>
            m.id === messageId ? { ...m, held: true } : m
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

  steerNow: (threadId, messageId) => {
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue?.some((m) => m.id === messageId && !m.held && !m.steer))
        return state
      return {
        queues: {
          ...state.queues,
          [threadId]: queue.map((m) =>
            m.id === messageId ? { ...m, steer: true } : m
          ),
        },
      }
    })
  },

  takeSteering: (threadId) => {
    let taken: QueuedMessage[] = []
    set((state) => {
      const queue = state.queues[threadId]
      if (!queue?.some(isSteering)) return state
      taken = queue.filter(isSteering)
      return {
        queues: {
          ...state.queues,
          [threadId]: queue.filter((m) => !isSteering(m)),
        },
      }
    })
    return taken
  },

  move: (threadId, messageId, delta) => {
    set((state) => {
      const queue = state.queues[threadId]
      const from = queue?.findIndex((m) => m.id === messageId) ?? -1
      if (!queue || from < 0) return state
      const to = Math.max(0, Math.min(queue.length - 1, from + delta))
      if (to === from) return state
      const next = [...queue]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return { queues: { ...state.queues, [threadId]: next } }
    })
  },

  reorder: (threadId, messageId, overId) => {
    const queue = get().queues[threadId]
    const from = queue?.findIndex((m) => m.id === messageId) ?? -1
    const to = queue?.findIndex((m) => m.id === overId) ?? -1
    if (from < 0 || to < 0 || from === to) return
    get().move(threadId, messageId, to - from)
  },
}))
