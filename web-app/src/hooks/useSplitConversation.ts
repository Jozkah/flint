import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * Split conversations: a second, fully independent Chat conversation shown
 * beside the one the route names.
 *
 * The route owns the primary pane's thread (`/threads/$threadId`). This store
 * only remembers whether the split is open, which thread the second pane
 * shows, which pane the user is working in, and how the width is shared.
 * Everything a conversation owns -- its session, stream, draft, attachments,
 * approvals, model -- stays keyed by its own thread id, so two panes never
 * share it.
 */

export type SplitPaneId = 'primary' | 'secondary'

export const SPLIT_MIN_RATIO = 0.3
export const SPLIT_MAX_RATIO = 0.7
export const SPLIT_DEFAULT_RATIO = 0.5

/** At and above this width the panes sit side by side; below, they take turns. */
export const SPLIT_SIDE_BY_SIDE_QUERY = '(min-width: 1100px)'

/** Where the second pane keeps its draft, apart from the main composer's. */
export const SECONDARY_DRAFT_SCOPE = 'split:secondary'

export function clampSplitRatio(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return SPLIT_DEFAULT_RATIO
  return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, n))
}

type SplitConversationState = {
  open: boolean
  secondaryThreadId?: string
  activePane: SplitPaneId
  /** Share of the width the primary pane takes when side by side. */
  ratio: number
  openSplit: () => void
  closeSplit: () => void
  setSecondaryThread: (threadId?: string) => void
  setActivePane: (pane: SplitPaneId) => void
  setRatio: (ratio: number) => void
}

export const useSplitConversation = create<SplitConversationState>()(
  persist(
    (set, get) => ({
      open: false,
      secondaryThreadId: undefined,
      activePane: 'primary',
      ratio: SPLIT_DEFAULT_RATIO,
      openSplit: () => set({ open: true, activePane: 'primary' }),
      closeSplit: () => set({ open: false, activePane: 'primary' }),
      setSecondaryThread: (threadId) => set({ secondaryThreadId: threadId }),
      setActivePane: (pane) => {
        if (get().activePane !== pane) set({ activePane: pane })
      },
      setRatio: (ratio) => set({ ratio: clampSplitRatio(ratio) }),
    }),
    {
      name: localStorageKey.splitConversation,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      // Which pane has focus is a moment, not a preference.
      partialize: (state) => ({
        open: state.open,
        secondaryThreadId: state.secondaryThreadId,
        ratio: state.ratio,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.ratio = clampSplitRatio(state.ratio)
      },
    }
  )
)
