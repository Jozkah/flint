import { create } from 'zustand'

/**
 * Sampling parameters chosen in the composer before a chat exists.
 *
 * A chat that has not been created yet has no per-chat record to write to,
 * and writing to the assistant instead would change that assistant for every
 * later chat (a seed typed here once stayed fixed for all new chats). So the
 * choice waits here, keyed by assistant, and is copied onto the new thread's
 * own assistant snapshot when the chat is created. Never persisted: a draft
 * that outlives the session would be the same leak by another route.
 */
type DraftSamplingState = {
  byAssistant: Record<string, Record<string, unknown>>
  set: (assistantId: string, params: Record<string, unknown>) => void
  /** Take the draft for a new chat, forgetting it. */
  take: (assistantId: string) => Record<string, unknown> | undefined
  clear: (assistantId: string) => void
  /** Forget every draft: a chat that takes none (a temporary chat) must not leave them for a later one. */
  clearAll: () => void
}

export const useDraftSampling = create<DraftSamplingState>()((set, get) => ({
  byAssistant: {},
  set: (assistantId, params) =>
    set((s) => ({ byAssistant: { ...s.byAssistant, [assistantId]: params } })),
  take: (assistantId) => {
    const draft = get().byAssistant[assistantId]
    if (draft) get().clear(assistantId)
    return draft
  },
  clearAll: () => set({ byAssistant: {} }),
  clear: (assistantId) =>
    set((s) => {
      if (!(assistantId in s.byAssistant)) return s
      const next = { ...s.byAssistant }
      delete next[assistantId]
      return { byAssistant: next }
    }),
}))
