import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/**
 * How much of a Cowork session's activity the timeline shows.
 *
 * Presentation only. Nothing here deletes an event: tool activity stays in the
 * session, in exports and in search whatever this says, and turning the option
 * off brings it straight back without a reload.
 */
type CoworkDisplayState = {
  /**
   * "Hide completed tool activity". Off by default -- seeing what the agent
   * did is the point of the timeline.
   *
   * Only cleanly successful activity is ever hidden. Running, awaiting
   * permission, failed, refused, cancelled and stale items are always shown.
   */
  hideCompletedTools: boolean
  setHideCompletedTools: (hide: boolean) => void
}

export const useCoworkDisplay = create<CoworkDisplayState>()(
  persist(
    (set) => ({
      hideCompletedTools: false,
      setHideCompletedTools: (hideCompletedTools) => set({ hideCompletedTools }),
    }),
    {
      name: localStorageKey.coworkDisplay,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({ hideCompletedTools: state.hideCompletedTools }),
    }
  )
)
