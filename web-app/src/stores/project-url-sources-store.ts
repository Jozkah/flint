import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/** Where a project file added from a web page came from. */
export type UrlSource = {
  /** The page address the person entered. */
  url: string
  /** When the page was last fetched (epoch ms). */
  fetchedAt: number
  /** The saved markdown file, as the project's file record holds it. */
  path: string
}

/**
 * Web page sources of project files, keyed `<projectId>` then file path. The
 * vector store's file record has no room for a source, so the URL and fetch
 * time live here beside it (and in the saved file's own header).
 */
type State = {
  sources: Record<string, Record<string, UrlSource>>
  put: (projectId: string, source: UrlSource) => void
  remove: (projectId: string, path: string) => void
}

export const useProjectUrlSources = create<State>()(
  persist(
    (set) => ({
      sources: {},
      put: (projectId, source) =>
        set((s) => ({
          sources: {
            ...s.sources,
            [projectId]: { ...s.sources[projectId], [source.path]: source },
          },
        })),
      remove: (projectId, path) =>
        set((s) => {
          if (!s.sources[projectId]?.[path]) return s
          const next = { ...s.sources[projectId] }
          delete next[path]
          return { sources: { ...s.sources, [projectId]: next } }
        }),
    }),
    {
      name: 'flint-project-url-sources',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
