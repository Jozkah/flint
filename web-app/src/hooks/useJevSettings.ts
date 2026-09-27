import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'
import type { JevMode } from '@/lib/jev'

/**
 * The two Jev opt-ins, separately, both `off` by default. Persisted to the
 * backend settings store under `flint-jev`, where `core::jev` reads them on
 * every call: the backend, not this page, decides whether a request is made.
 * The API key is not here -- it lives in the protected secret store.
 */
type JevSettingsState = {
  skillMode: JevMode
  rerankMode: JevMode
  setSkillMode: (mode: JevMode) => void
  setRerankMode: (mode: JevMode) => void
}

export const JEV_SETTINGS_KEY = 'flint-jev'

export const useJevSettings = create<JevSettingsState>()(
  persist(
    (set) => ({
      skillMode: 'off',
      rerankMode: 'off',
      setSkillMode: (skillMode) => set({ skillMode }),
      setRerankMode: (rerankMode) => set({ rerankMode }),
    }),
    {
      name: JEV_SETTINGS_KEY,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) =>
        ({ skillMode: s.skillMode, rerankMode: s.rerankMode }) as unknown as JevSettingsState,
    }
  )
)
