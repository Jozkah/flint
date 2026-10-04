import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

export type BackgroundSection = 'running' | 'finished'

/**
 * Which sections of the Background tasks tab a session has collapsed.
 *
 * Only the view's own preference, so it lives apart from the activity record
 * (which is the single source of truth for the tasks themselves) and is kept
 * per session: collapsing "Finished" in one conversation does not collapse it
 * in another. Stored in the webview's localStorage; losing it only re-expands
 * the sections.
 */
type State = {
  collapsed: Record<string, Partial<Record<BackgroundSection, boolean>>>
  isCollapsed: (sessionId: string, section: BackgroundSection) => boolean
  toggle: (sessionId: string, section: BackgroundSection) => void
  forget: (sessionId: string) => void
}

export const useBackgroundTabState = create<State>()(
  persist(
    (set, get) => ({
      collapsed: {},
      isCollapsed: (sessionId, section) =>
        get().collapsed[sessionId]?.[section] === true,
      toggle: (sessionId, section) =>
        set((s) => ({
          collapsed: {
            ...s.collapsed,
            [sessionId]: {
              ...s.collapsed[sessionId],
              [section]: !(s.collapsed[sessionId]?.[section] === true),
            },
          },
        })),
      forget: (sessionId) =>
        set((s) => {
          const collapsed = { ...s.collapsed }
          delete collapsed[sessionId]
          return { collapsed }
        }),
    }),
    {
      name: localStorageKey.coworkBackgroundTab,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ collapsed: s.collapsed }),
    }
  )
)
