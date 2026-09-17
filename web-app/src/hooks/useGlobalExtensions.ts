import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'

export type Scope = 'workspace' | 'global'

interface GlobalExtensionsState {
  pluginScopes: Record<string, Scope>
  skillScopes: Record<string, Scope>

  setPluginScope: (id: string, scope: Scope) => void
  removePluginScope: (id: string) => void
  setSkillScope: (name: string, scope: Scope) => void
  removeSkillScope: (name: string) => void

  getPluginScope: (id: string) => Scope
  getSkillScope: (name: string) => Scope

  globalPlugins: () => string[]
  globalSkills: () => string[]
}

export const useGlobalExtensions = create<GlobalExtensionsState>()(
  persist(
    (set, get) => ({
      pluginScopes: {},
      skillScopes: {},

      setPluginScope: (id, scope) =>
        set({ pluginScopes: { ...get().pluginScopes, [id]: scope } }),

      removePluginScope: (id) => {
        const next = { ...get().pluginScopes }
        delete next[id]
        set({ pluginScopes: next })
      },

      setSkillScope: (name, scope) =>
        set({ skillScopes: { ...get().skillScopes, [name]: scope } }),

      removeSkillScope: (name) => {
        const next = { ...get().skillScopes }
        delete next[name]
        set({ skillScopes: next })
      },

      getPluginScope: (id) => get().pluginScopes[id] ?? 'workspace',

      getSkillScope: (name) => get().skillScopes[name] ?? 'workspace',

      globalPlugins: () =>
        Object.entries(get().pluginScopes)
          .filter(([, scope]) => scope === 'global')
          .map(([id]) => id),

      globalSkills: () =>
        Object.entries(get().skillScopes)
          .filter(([, scope]) => scope === 'global')
          .map(([name]) => name),
    }),
    {
      name: 'globalExtensions',
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
