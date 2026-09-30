import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'

/**
 * Switches for what Flint decides for the user per message, each on its own.
 * Both default to on, which is how Flint already behaved; the work profile has
 * its own switch (`useWorkProfiles.enabled`). Turning one off makes Flint do
 * exactly what it does when the user has made that choice by hand.
 */
type AutomationState = {
  /** Jev may move a conversation still on Flint to a specialist assistant. */
  routeAssistants: boolean
  /** Skills apply by themselves: always-active, triggered, or picked by Jev. */
  activateSkills: boolean
  setRouteAssistants: (on: boolean) => void
  setActivateSkills: (on: boolean) => void
}

export const AUTOMATION_SETTINGS_KEY = 'flint-automation'

export const useAutomationSettings = create<AutomationState>()(
  persist(
    (set) => ({
      routeAssistants: true,
      activateSkills: true,
      setRouteAssistants: (routeAssistants) => set({ routeAssistants }),
      setActivateSkills: (activateSkills) => set({ activateSkills }),
    }),
    {
      name: AUTOMATION_SETTINGS_KEY,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) =>
        ({
          routeAssistants: s.routeAssistants,
          activateSkills: s.activateSkills,
        }) as unknown as AutomationState,
    }
  )
)
