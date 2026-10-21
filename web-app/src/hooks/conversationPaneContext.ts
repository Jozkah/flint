import { createContext, useContext } from 'react'
import type { SplitPaneId } from '@/hooks/useSplitConversation'

/**
 * Which conversation pane a component is rendered in.
 *
 * Absent outside the Chat thread view. With the split closed there is one
 * pane and it is always active, so everything reads exactly as it did before
 * split conversations existed.
 *
 * Kept free of store imports so a leaf component (a tool card) can read the
 * thread it is drawn in without loading the model and thread stores.
 */
export type ConversationPane = {
  paneId: SplitPaneId
  threadId: string
  /** Two panes are on screen. */
  isSplit: boolean
  /** The pane the user is working in. Only it drives global selections. */
  isActive: boolean
}

export const ConversationPaneContext = createContext<ConversationPane | null>(
  null
)

export function useConversationPane(): ConversationPane | null {
  return useContext(ConversationPaneContext)
}
