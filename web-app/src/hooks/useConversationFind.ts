import { create } from 'zustand'

/**
 * Whether the find bar is open over the conversation on screen. One bar at a
 * time: the shortcut opens it, the conversation that is active shows it.
 */
type ConversationFindState = {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useConversationFind = create<ConversationFindState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
