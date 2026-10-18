import { useEffect } from 'react'
import { create } from 'zustand'

/** What to look for when the find bar is opened for a search hit. */
export type FindSeed = { threadId: string; query: string; messageId?: string }

type ConversationFindState = {
  open: boolean
  setOpen: (open: boolean) => void
  /** Set when a cross-chat search hit opens a chat: the bar starts on it. */
  seed: FindSeed | null
  /**
   * The chat a search hit opened the bar for. It outlives the seed: the bar
   * (a child) takes the seed before its chat's mount effect runs, and that
   * effect must still know the bar is this chat's.
   */
  owner: string | null
  openWith: (seed: FindSeed) => void
  clearSeed: () => void
}

export const useConversationFind = create<ConversationFindState>()((set) => ({
  open: false,
  // Opening by hand (Ctrl+F) or closing drops any search-hit seed.
  setOpen: (open) => set({ open, seed: null, owner: null }),
  seed: null,
  owner: null,
  openWith: (seed) => set({ open: true, seed, owner: seed.threadId }),
  clearSeed: () => set({ seed: null }),
}))

/**
 * The find bar belongs to the chat it was opened in, so showing another chat
 * closes it. Except for the chat a search hit opened it for (its bar may have
 * consumed the seed already: child effects run before the parent's), and
 * while a seed is still pending for a chat that has not mounted yet
 * (navigating from Home, split panes, a lazily loaded thread).
 */
export function closeFindForThread(threadId?: string): void {
  const { seed, owner, open, setOpen } = useConversationFind.getState()
  if (seed) return
  if (threadId !== undefined && owner === threadId) return
  if (open || owner) setOpen(false)
}

/** A seed is waiting for a different chat: this one must not show the bar. */
export function findSeedIsForOther(
  seed: FindSeed | null,
  threadId: string
): boolean {
  return !!seed && seed.threadId !== threadId
}

/** The find bar state as one conversation sees it. */
export function useThreadFind(threadId: string) {
  const findOpen = useConversationFind((s) => s.open)
  const findSeed = useConversationFind((s) =>
    s.seed && s.seed.threadId === threadId ? s.seed : null
  )
  const findWaitsForOther = useConversationFind((s) =>
    findSeedIsForOther(s.seed, threadId)
  )
  useEffect(() => {
    closeFindForThread(threadId)
  }, [threadId])
  return { findOpen, findSeed, findWaitsForOther }
}
