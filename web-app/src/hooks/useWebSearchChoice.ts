import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'

/**
 * Web search per chat (a thread id) or per Cowork session (`cowork:<id>`).
 *
 * The rule: a chat the user has not decided on follows Settings > Web Search
 * (on there means on by default); once the user flips the composer's switch
 * for a chat, that choice is stored here and wins, whatever Settings says
 * later. Nothing is migrated: an absent entry simply means "follow Settings".
 */
export function resolveWebSearch(
  settingsOn: boolean,
  explicit: boolean | undefined
): boolean {
  return explicit ?? settingsOn
}

/** The Cowork scope key for a session. */
export const coworkWebSearchScope = (sessionId: string) => `cowork:${sessionId}`

type WebSearchChoiceState = {
  byScope: Record<string, boolean>
  set: (scope: string, on: boolean) => void
  /** Hand a draft's choice (home screen) to the chat it became. */
  move: (from: string, to: string) => void
}

export const useWebSearchChoice = create<WebSearchChoiceState>()(
  persist(
    (set) => ({
      byScope: {},
      set: (scope, on) =>
        set((s) => ({ byScope: { ...s.byScope, [scope]: on } })),
      move: (from, to) =>
        set((s) => {
          if (!(from in s.byScope)) return s
          const next = { ...s.byScope, [to]: s.byScope[from] }
          delete next[from]
          return { byScope: next }
        }),
    }),
    {
      name: localStorageKey.webSearchChoice,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({ byScope: state.byScope }),
    }
  )
)

/** Whether web search is on for `scope`, read outside React. */
export function webSearchOnFor(scope?: string | null): boolean {
  const settingsOn = useWebSearchConfig.getState().webSearchEnabled
  const explicit = scope
    ? useWebSearchChoice.getState().byScope[scope]
    : undefined
  return resolveWebSearch(settingsOn, explicit)
}

/** Whether web search is on for `scope`, subscribed. */
export function useWebSearchOn(scope?: string | null): boolean {
  const settingsOn = useWebSearchConfig((s) => s.webSearchEnabled)
  const explicit = useWebSearchChoice((s) =>
    scope ? s.byScope[scope] : undefined
  )
  return resolveWebSearch(settingsOn, explicit)
}
