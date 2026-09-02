import { useEffect } from 'react'
import { useLocation } from '@tanstack/react-router'
import { create } from 'zustand'

type SettingsSearchState = {
  /** The live query. Held outside the component so it survives the sidebar
   * remounting on every settings route change — the query has to outlive the
   * navigation it triggers. */
  query: string
  setQuery: (query: string) => void
  clear: () => void
  /**
   * Anchor id of the setting to reveal once its page mounts. Same
   * consume-once pattern as `useCoworkRun.pendingPreview`: the result row
   * parks the id here and navigates, and the mounted `SettingTarget` claims
   * it. Claimed rather than left in place so returning to the page later does
   * not re-scroll and re-highlight out of nowhere.
   */
  pendingTarget: string | null
  requestTarget: (anchor: string) => void
  /** Claim `anchor` if it is the pending one. True exactly once per request. */
  consumeTarget: (anchor: string) => boolean
  /**
   * Whether the results panel has been dismissed for the current query.
   *
   * Held here rather than in the component for the same reason as `query`:
   * every settings page renders its own `SettingsMenu`, so selecting a result
   * unmounts the search field and mounts a fresh one. Local state came back
   * `false` with the query still set, and the panel the user had just chosen
   * from reopened on top of the page they had just navigated to.
   */
  dismissed: boolean
  setDismissed: (dismissed: boolean) => void
}

export const useSettingsSearch = create<SettingsSearchState>((set, get) => ({
  query: '',
  // A new query drops any unclaimed target. Some anchors belong to controls
  // that only render under a condition (web search shows either an endpoint or
  // an API key, never both), so a request can go unclaimed; without this it
  // would sit there and fire the next time that page happened to mount the
  // matching control, scrolling somewhere the user never asked to go.
  setQuery: (query) => set({ query, pendingTarget: null, dismissed: false }),
  clear: () => set({ query: '', pendingTarget: null, dismissed: false }),
  pendingTarget: null,
  requestTarget: (anchor) => set({ pendingTarget: anchor }),
  consumeTarget: (anchor) => {
    if (get().pendingTarget !== anchor) return false
    set({ pendingTarget: null })
    return true
  },
  dismissed: false,
  setDismissed: (dismissed) => set({ dismissed }),
}))

/** Settings routes, which the query is allowed to outlive. */
const SETTINGS_PREFIX = '/settings'

/**
 * Drop the query once the user leaves Settings.
 *
 * The store deliberately outlives each settings page, so a query survives
 * navigation between them. It must not survive leaving the section: coming
 * back to Settings hours later to a stale query and its open result list is
 * not something anyone asked for.
 *
 * Mounted once, high enough to stay put across routes — the per-page
 * `SettingsMenu` unmounts on every settings navigation, so clearing from
 * there would wipe the query this store exists to preserve.
 */
export function useClearSettingsSearchOnExit(): void {
  const { pathname } = useLocation()
  const inSettings =
    pathname === SETTINGS_PREFIX || pathname.startsWith(`${SETTINGS_PREFIX}/`)

  useEffect(() => {
    if (inSettings) return
    const { query, pendingTarget } = useSettingsSearch.getState()
    // Guarded so an unrelated navigation is not a store write.
    if (query !== '' || pendingTarget !== null) {
      useSettingsSearch.getState().clear()
    }
  }, [inSettings])
}
