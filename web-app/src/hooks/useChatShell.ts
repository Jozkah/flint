import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

type ChatShellState = {
  /**
   * Whether plain Chat offers the model its sandboxed shell. On by default so
   * nobody loses the shell they have today. Separate from Settings > Agent
   * Tools, which also governs Cowork: this one is Chat's own, and Cowork does
   * not read it.
   */
  shellEnabled: boolean
  setShellEnabled: (value: boolean) => void
}

export const useChatShell = create<ChatShellState>()(
  persist(
    (set) => ({
      shellEnabled: true,
      setShellEnabled: (shellEnabled) => set({ shellEnabled }),
    }),
    {
      name: localStorageKey.settingChatShell,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
