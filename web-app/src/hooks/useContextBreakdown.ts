import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import type { ContextBreakdown } from '@/lib/contextBreakdown'

/**
 * The context breakdown of the last request each conversation sent, by thread
 * or session id, and the window the server was running it in. Written by the
 * transport when it builds a request, read by the composer's context circle.
 *
 * Kept across restarts. What it describes is a request that was sent, and that
 * stays true while the chat sits for days; without it an old chat opened again
 * showed no context card until something was sent. The next request replaces
 * it. `at` says how old it is.
 */
type ContextBreakdownState = {
  byId: Record<string, ContextBreakdown>
  /** The window the chat's server ran with, when it was last learned. */
  windowById: Record<string, number>
  set: (id: string, breakdown: ContextBreakdown) => void
  setWindow: (id: string, tokens: number) => void
  clear: (id: string) => void
}

export const useContextBreakdown = create<ContextBreakdownState>()(
  persist(
    (set) => ({
      byId: {},
      windowById: {},
      set: (id, breakdown) =>
        set((s) => ({ byId: { ...s.byId, [id]: breakdown } })),
      setWindow: (id, tokens) =>
        set((s) =>
          s.windowById[id] === tokens
            ? s
            : { windowById: { ...s.windowById, [id]: tokens } }
        ),
      clear: (id) =>
        set((s) => {
          const byId = { ...s.byId }
          const windowById = { ...s.windowById }
          delete byId[id]
          delete windowById[id]
          return { byId, windowById }
        }),
    }),
    {
      name: localStorageKey.contextBreakdown,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      version: 1,
      partialize: (state) => ({
        byId: state.byId,
        windowById: state.windowById,
      }),
    }
  )
)
