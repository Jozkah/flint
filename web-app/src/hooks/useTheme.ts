import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getServiceHub } from '@/hooks/useServiceHub'
import { backendStorage } from '@/lib/backendStorage'
import type { ThemeMode } from '@/services/theme/types'
import { localStorageKey } from '@/constants/localStorage'
import { isChatWindow } from '@/lib/soloFlag'
import type { StateStorage } from 'zustand/middleware'

/**
 * The theme storage a window may write. Only the main window saves the theme:
 * a chat window (or a hidden spare) still holding 'auto' saved it over the
 * user's Light/Dark choice. Others read it and never write.
 */
export function themeStorageFor(
  storage: StateStorage,
  chatWindow: boolean = isChatWindow()
): StateStorage {
  if (!chatWindow) return storage
  return { ...storage, setItem: () => {}, removeItem: () => {} }
}

// Function to check if OS prefers dark mode
export const checkOSDarkMode = (): boolean => {
  return (
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

export type ThemeState = {
  activeTheme: AppTheme
  setTheme: (theme: AppTheme) => void
  isDark: boolean
  setIsDark: (isDark: boolean) => void
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => {
      // Initialize isDark based on OS preference if theme is auto
      const initialState = {
        activeTheme: 'auto' as AppTheme,
        isDark: checkOSDarkMode(),
        setTheme: async (activeTheme: AppTheme) => {
          // Commit first so the theme-changed listener (which gates on
          // activeTheme) ignores any portal/WindowEvent fired by the native
          // setTheme call below. Otherwise events arriving while activeTheme
          // is still stale ('auto') overwrite isDark with the system value.
          if (activeTheme === 'auto') {
            set(() => ({ activeTheme, isDark: checkOSDarkMode() }))
            await getServiceHub().theme().setTheme(null)
          } else {
            set(() => ({ activeTheme, isDark: activeTheme === 'dark' }))
            await getServiceHub()
              .theme()
              .setTheme(activeTheme as ThemeMode)
          }
        },
        setIsDark: (isDark: boolean) => set(() => ({ isDark })),
      }

      // Check if we should initialize with dark mode
      if (initialState.activeTheme === 'auto') {
        initialState.isDark = checkOSDarkMode()
      } else {
        initialState.isDark = initialState.activeTheme === 'dark'
      }

      return initialState
    },
    {
      name: localStorageKey.theme,
      storage: createJSONStorage(() => themeStorageFor(backendStorage)),
      // Backend storage is async; hydrate explicitly after ServiceHub init
      // (see hydrateBackendStores). getServiceHub() throws before that.
      skipHydration: true,
      // Persisted isDark from the previous session can be stale (user changed
      // OS theme while the app was closed). Re-derive on hydration so the
      // initial render matches reality; the Tauri portal listener corrects
      // Linux where matchMedia is unreliable.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.activeTheme === 'auto') state.isDark = checkOSDarkMode()
        else state.isDark = state.activeTheme === 'dark'
      },
    }
  )
)
