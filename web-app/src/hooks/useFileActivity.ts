import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  mergeEvents,
  type FileActivityEvent,
} from '@/lib/fileActivity'

/**
 * What each conversation did to which files.
 *
 * Persisted with the conversation so the record survives a restart, and keyed
 * by conversation id so one session's paths can never appear under another's.
 *
 * Only references are kept — path, operation, tool call id, whether a diff
 * exists. Contents already live in the transcript and in the diffs the tools
 * produced; storing them again would double the session for no new
 * information.
 */

/** Beyond this, a conversation's list is trimmed oldest-first. */
export const MAX_EVENTS_PER_CONVERSATION = 2000

type FileActivityState = {
  byConversation: Record<string, FileActivityEvent[]>
  /** Append events, ignoring any already recorded. */
  record: (conversationId: string, events: FileActivityEvent[]) => void
  eventsFor: (conversationId: string | null | undefined) => FileActivityEvent[]
  /** Forget a deleted conversation, so its paths do not outlive it. */
  forget: (conversationId: string) => void
}

const EMPTY: FileActivityEvent[] = []

export const useFileActivity = create<FileActivityState>()(
  persist(
    (set, get) => ({
      byConversation: {},

      record: (conversationId, events) => {
        if (!conversationId || events.length === 0) return
        const current = get().byConversation[conversationId] ?? EMPTY
        const merged = mergeEvents(current, events)
        // `mergeEvents` hands back the same array when nothing is new, which
        // is the common case on a re-render: skip the write entirely.
        if (merged === current) return
        const trimmed =
          merged.length > MAX_EVENTS_PER_CONVERSATION
            ? merged.slice(merged.length - MAX_EVENTS_PER_CONVERSATION)
            : merged
        set((s) => ({
          byConversation: { ...s.byConversation, [conversationId]: trimmed },
        }))
      },

      eventsFor: (conversationId) =>
        (conversationId && get().byConversation[conversationId]) || EMPTY,

      forget: (conversationId) =>
        set((s) => {
          if (!(conversationId in s.byConversation)) return s
          const next = { ...s.byConversation }
          delete next[conversationId]
          return { byConversation: next }
        }),
    }),
    {
      name: localStorageKey.fileActivity,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({ byConversation: state.byConversation }),
    }
  )
)
