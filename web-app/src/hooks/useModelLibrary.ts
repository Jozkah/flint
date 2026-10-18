import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * Per-user model library state that has to outlive a page visit:
 * - `folders`: extra folders of GGUF models (or an Ollama store) the user
 *   added; they are scanned along with the other apps' usual folders.
 * - `filterQuery`: the model filter text per provider, so leaving a provider
 *   page and coming back does not wipe it.
 * - `expandedGroups`: which model-family groups are open per provider; groups
 *   start collapsed.
 */
interface ModelLibraryState {
  folders: string[]
  filterQuery: Record<string, string>
  expandedGroups: Record<string, string[]>
  addFolder: (folder: string) => void
  removeFolder: (folder: string) => void
  setFilterQuery: (provider: string, query: string) => void
  toggleGroup: (provider: string, group: string) => void
}

export const useModelLibrary = create<ModelLibraryState>()(
  persist(
    (set) => ({
      folders: [],
      filterQuery: {},
      expandedGroups: {},
      addFolder: (folder) =>
        set((s) => {
          const trimmed = folder.trim()
          if (!trimmed || s.folders.includes(trimmed)) return s
          return { folders: [...s.folders, trimmed] }
        }),
      removeFolder: (folder) =>
        set((s) => ({ folders: s.folders.filter((f) => f !== folder) })),
      setFilterQuery: (provider, query) =>
        set((s) => {
          const next = { ...s.filterQuery }
          if (query) next[provider] = query
          else delete next[provider]
          return { filterQuery: next }
        }),
      toggleGroup: (provider, group) =>
        set((s) => {
          const open = s.expandedGroups[provider] ?? []
          return {
            expandedGroups: {
              ...s.expandedGroups,
              [provider]: open.includes(group)
                ? open.filter((g) => g !== group)
                : [...open, group],
            },
          }
        }),
    }),
    {
      name: localStorageKey.modelLibrary,
      storage: createJSONStorage(() => backendStorage),
      // Async backend storage; hydrated explicitly after ServiceHub init.
      skipHydration: true,
    }
  )
)
