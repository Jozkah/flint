import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'

type WebPreviewSettings = {
  /** When on, clicking an external link opens the in-app preview instead of
   * the system browser. */
  interceptLinks: boolean
  setInterceptLinks: (interceptLinks: boolean) => void
}

export const useWebPreviewSettings = create<WebPreviewSettings>()(
  persist(
    (set) => ({
      interceptLinks: true,
      setInterceptLinks: (interceptLinks) => set({ interceptLinks }),
    }),
    {
      name: localStorageKey.settingWebPreview,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
