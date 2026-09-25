import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * When each chat or Cowork session was last looked at, in epoch ms.
 *
 * The sidebar's blue "recent" dot means "finished since you last looked".
 * Without this record it meant "changed in the last hour", so a chat the user
 * had already read kept its dot for up to an hour after the run ended.
 */
type SeenState = {
  seen: Record<string, number>
  markSeen: (id: string, at?: number) => void
}

/** Entries older than this are dropped when a new one is written. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

export const useSeen = create<SeenState>()(
  persist(
    (set) => ({
      seen: {},
      markSeen: (id, at = Date.now()) =>
        set((state) => {
          if ((state.seen[id] ?? 0) >= at) return state
          const cutoff = at - KEEP_MS
          const seen: Record<string, number> = {}
          for (const [key, value] of Object.entries(state.seen))
            if (value >= cutoff) seen[key] = value
          seen[id] = at
          return { seen }
        }),
    }),
    {
      name: 'flint-seen-threads',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
