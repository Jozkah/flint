import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  INITIAL_GUIDE_STATE,
  type GuideState,
  type GuideStepId,
  type Intent,
  type SetupPage,
} from '@/lib/onboarding'

interface OnboardingGuideStore extends GuideState {
  /** Starts (or restarts) the guide for an intention. */
  start: (intent: Intent | null, threadCount: number) => void
  setIntent: (intent: Intent | null) => void
  setSetupPage: (page: SetupPage) => void
  confirmStep: (step: GuideStepId) => void
  /** Hides the guide; it can be reopened from Settings. Changes nothing else. */
  skip: () => void
  complete: () => void
}

export const useOnboardingGuide = create<OnboardingGuideStore>()(
  persist(
    (set) => ({
      ...INITIAL_GUIDE_STATE,

      start: (intent, threadCount) =>
        set({
          status: 'in-progress',
          intent,
          threadCountAtStart: threadCount,
          confirmedSteps: [],
        }),

      setIntent: (intent) => set({ intent }),

      setSetupPage: (setupPage) => set({ setupPage }),

      confirmStep: (step) =>
        set((state) =>
          state.confirmedSteps.includes(step)
            ? state
            : { confirmedSteps: [...state.confirmedSteps, step] }
        ),

      skip: () => set({ status: 'skipped' }),

      complete: () => set({ status: 'completed' }),
    }),
    {
      name: localStorageKey.onboardingGuide,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (state) => ({
        status: state.status,
        intent: state.intent,
        threadCountAtStart: state.threadCountAtStart,
        confirmedSteps: state.confirmedSteps,
        setupPage: state.setupPage,
      }),
    }
  )
)
