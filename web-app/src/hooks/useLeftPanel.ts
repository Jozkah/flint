import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

/** Flint Atelier contextual sidebar: 256px by default, resizable 220-300px. */
export const SIDEBAR_DEFAULT_WIDTH = '16rem'
export const SIDEBAR_MIN_REM = 13.75
export const SIDEBAR_MAX_REM = 18.75

export function clampSidebarWidth(value: unknown): string {
  const rem =
    typeof value === 'number'
      ? value / 16
      : typeof value === 'string' && value.endsWith('px')
        ? parseFloat(value) / 16
        : typeof value === 'string'
          ? parseFloat(value)
          : NaN
  if (!Number.isFinite(rem)) return SIDEBAR_DEFAULT_WIDTH
  const clamped = Math.min(SIDEBAR_MAX_REM, Math.max(SIDEBAR_MIN_REM, rem))
  return `${Math.round(clamped * 100) / 100}rem`
}

type LeftPanelStoreState = {
  open: boolean
  size: number
  width: string // Sidebar width in rem (e.g., "15rem")
  setLeftPanel: (value: boolean) => void
  setLeftPanelSize: (value: number) => void
  setLeftPanelWidth: (value: string) => void
}

export const useLeftPanel = create<LeftPanelStoreState>()(
  persist(
    (set) => ({
      open: true,
      size: 20, // Default size of 20%
      width: SIDEBAR_DEFAULT_WIDTH,
      setLeftPanel: (value) => set({ open: value }),
      setLeftPanelSize: (value) => set({ size: value }),
      setLeftPanelWidth: (value) => set({ width: clampSidebarWidth(value) }),
    }),
    {
      name: localStorageKey.LeftPanel,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      // A width saved by the previous layout (14-20rem) is brought into the
      // Atelier range rather than discarded.
      onRehydrateStorage: () => (state) => {
        if (state) state.width = clampSidebarWidth(state.width)
      },
    }
  )
)
