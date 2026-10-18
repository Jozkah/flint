import { create } from 'zustand'

/** What to look for when the find bar is opened for a search hit. */
export type FindSeed = { threadId: string; query: string; messageId?: string }

type ConversationFindState = {
  open: boolean
  setOpen: (open: boolean) => void
  /** Set when a cross-chat search hit opens a chat: the bar starts on it. */
  seed: FindSeed | null
  openWith: (seed: FindSeed) => void
  clearSeed: () => void
}

export const useConversationFind = create<ConversationFindState>()((set) => ({
  open: false,
  setOpen: (open) => set(open ? { open } : { open, seed: null }),
  seed: null,
  openWith: (seed) => set({ open: true, seed }),
  clearSeed: () => set({ seed: null }),
}))

/**
 * The find bar belongs to the chat it was opened in, so showing another chat
 * closes it. Except for the chat a search hit just asked it to open for: that
 * chat mounts after the request, and closing here would also drop the seed.
 */
export function closeFindForThread(threadId: string): void {
  const { seed, setOpen } = useConversationFind.getState()
  if (seed?.threadId === threadId) return
  setOpen(false)
}
