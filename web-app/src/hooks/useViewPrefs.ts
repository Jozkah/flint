import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/** How many repos one Hugging Face search returns; the Hub caps a page at 1000. */
export const HUB_RESULT_LIMITS = [50, 100, 200, 500, 1000]
export type ServersView = 'cards' | 'list'

type ViewPrefsState = {
  hubResultLimit: number
  /** Null until the user picks one; the page then chooses by server count. */
  mcpServersView: ServersView | null
  setHubResultLimit: (limit: number) => void
  setMcpServersView: (view: ServersView) => void
}

// These two used to live straight in localStorage under these keys.
const LEGACY_HUB_LIMIT_KEY = 'flint-hub-result-limit'
const LEGACY_SERVERS_VIEW_KEY = 'flint-mcp-servers-view'

function legacy(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function sanitizeHubLimit(value: unknown): number {
  const n = Number(value)
  return HUB_RESULT_LIMITS.includes(n) ? n : HUB_RESULT_LIMITS[0]
}

export function sanitizeServersView(value: unknown): ServersView | null {
  return value === 'cards' || value === 'list' ? value : null
}

export const useViewPrefs = create<ViewPrefsState>()(
  persist(
    (set) => ({
      hubResultLimit: HUB_RESULT_LIMITS[0],
      mcpServersView: null,
      setHubResultLimit: (limit) =>
        set({ hubResultLimit: sanitizeHubLimit(limit) }),
      setMcpServersView: (view) =>
        set({ mcpServersView: sanitizeServersView(view) }),
    }),
    {
      name: localStorageKey.viewPrefs,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({
        hubResultLimit: state.hubResultLimit,
        mcpServersView: state.mcpServersView,
      }),
      // A hand-edited blob never lifts a value out of range; a value the
      // backend has not seen yet is picked up from the old localStorage key.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as {
          hubResultLimit?: unknown
          mcpServersView?: unknown
        }
        return {
          ...current,
          hubResultLimit: sanitizeHubLimit(
            saved.hubResultLimit ?? legacy(LEGACY_HUB_LIMIT_KEY)
          ),
          mcpServersView: sanitizeServersView(
            saved.mcpServersView ?? legacy(LEGACY_SERVERS_VIEW_KEY)
          ),
        }
      },
    }
  )
)
