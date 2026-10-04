import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import type { ContextBreakdown } from '@/lib/contextBreakdown'

/**
 * The last figures a conversation showed: what was in use, the window it was
 * measured against, which model that was, and when. Small on purpose.
 */
export type LastContext = {
  used: number
  window?: number
  model?: string
  at: number
}

/** Conversations remembered; the least recently updated go first. */
const MAX_REMEMBERED = 300

/** `rec` with its oldest-inserted keys dropped down to `max`. */
function capKeys<T>(rec: Record<string, T>, max: number): Record<string, T> {
  const keys = Object.keys(rec)
  if (keys.length <= max) return rec
  const out: Record<string, T> = {}
  for (const k of keys.slice(keys.length - max)) out[k] = rec[k]
  return out
}

/** `rec` with `id` set and moved to the newest position. */
function touch<T>(rec: Record<string, T>, id: string, value: T): Record<string, T> {
  const rest = { ...rec }
  delete rest[id]
  return capKeys({ ...rest, [id]: value }, MAX_REMEMBERED)
}

/**
 * The context breakdown of the last request each conversation sent, by thread
 * or session id, and the window the server was running it in. Written by the
 * transport when it builds a request, read by the composer's context circle.
 *
 * Kept across restarts. What it describes is a request that was sent, and that
 * stays true while the chat sits for days; without it an old chat opened again
 * showed no context card until something was sent. The next request replaces
 * it. `at` says how old it is, and age only ever changes the label: nothing
 * here expires.
 */
type ContextBreakdownState = {
  byId: Record<string, ContextBreakdown>
  /** The window the chat's server ran with, when it was last learned. */
  windowById: Record<string, number>
  /** The model that window belongs to, so a model change does not inherit it. */
  windowModelById: Record<string, string>
  /** Used tokens and window as last shown, for a chat reopened before its
   * messages or its model are back. */
  lastById: Record<string, LastContext>
  set: (id: string, breakdown: ContextBreakdown) => void
  setWindow: (id: string, tokens: number, model?: string) => void
  setLast: (id: string, last: LastContext) => void
  clear: (id: string) => void
}

export const useContextBreakdown = create<ContextBreakdownState>()(
  persist(
    (set) => ({
      byId: {},
      windowById: {},
      windowModelById: {},
      lastById: {},
      set: (id, breakdown) =>
        set((s) => ({ byId: touch(s.byId, id, breakdown) })),
      setWindow: (id, tokens, model) =>
        set((s) =>
          s.windowById[id] === tokens && s.windowModelById[id] === model
            ? s
            : {
                windowById: touch(s.windowById, id, tokens),
                windowModelById: model
                  ? touch(s.windowModelById, id, model)
                  : s.windowModelById,
              }
        ),
      setLast: (id, last) => set((s) => ({ lastById: touch(s.lastById, id, last) })),
      clear: (id) =>
        set((s) => {
          const byId = { ...s.byId }
          const windowById = { ...s.windowById }
          const windowModelById = { ...s.windowModelById }
          const lastById = { ...s.lastById }
          delete byId[id]
          delete windowById[id]
          delete windowModelById[id]
          delete lastById[id]
          return { byId, windowById, windowModelById, lastById }
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
        windowModelById: state.windowModelById,
        lastById: state.lastById,
      }),
    }
  )
)
