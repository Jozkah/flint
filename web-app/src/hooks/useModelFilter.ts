import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * Whether model pickers hide models that cannot be used right now: a remote
 * provider with no API key, or one whose endpoint just failed to answer.
 *
 * One switch for every picker, so choosing it in one place holds in the rest.
 * It survives a restart, like the sort order.
 */
interface ModelFilterState {
  hideUnavailable: boolean
  setHideUnavailable: (hide: boolean) => void
}

export const useModelFilter = create<ModelFilterState>()(
  persist(
    (set) => ({
      hideUnavailable: false,
      setHideUnavailable: (hideUnavailable) => set({ hideUnavailable }),
    }),
    {
      name: localStorageKey.modelFilter,
      storage: createJSONStorage(() => backendStorage),
      // Async backend storage; hydrated explicitly after ServiceHub init.
      skipHydration: true,
      partialize: (state) => ({ hideUnavailable: state.hideUnavailable }),
    }
  )
)
