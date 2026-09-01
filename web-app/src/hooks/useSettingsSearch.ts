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
}

export const useSettingsSearch = create<SettingsSearchState>((set, get) => ({
  query: '',
  setQuery: (query) => set({ query }),
  clear: () => set({ query: '', pendingTarget: null }),
  pendingTarget: null,
  requestTarget: (anchor) => set({ pendingTarget: anchor }),
  consumeTarget: (anchor) => {
    if (get().pendingTarget !== anchor) return false
    set({ pendingTarget: null })
    return true
  },
}))
