import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

type LeanToolsConfigState = {
  /**
   * Leave the low-value tools (`lib/leanTools.ts`) out of a plain chat whose
   * model has a window of 32K tokens or less.
   */
  leanSmallWindows: boolean
  setLeanSmallWindows: (value: boolean) => void
  /** Hold the specialist host and browser tools back until a chat asks for them. */
  leanSpecialist: boolean
  setLeanSpecialist: (value: boolean) => void
}

/** On by default: a small model's window is better spent on the conversation. */
export const useLeanToolsConfig = create<LeanToolsConfigState>()(
  persist(
    (set) => ({
      leanSmallWindows: true,
      setLeanSmallWindows: (leanSmallWindows) => set({ leanSmallWindows }),
      leanSpecialist: true,
      setLeanSpecialist: (leanSpecialist) => set({ leanSpecialist }),
    }),
    {
      name: localStorageKey.settingLeanTools,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
