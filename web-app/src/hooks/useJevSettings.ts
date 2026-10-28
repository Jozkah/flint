import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'
import type { JevMode } from '@/lib/jev'
import { JEV_BACKEND, type DecisionBackend } from '@/lib/decisionBackends'

/**
 * The two Jev opt-ins, separately, both `off` by default. Persisted to the
 * backend settings store under `flint-jev`, where `core::jev` reads them on
 * every call: the backend, not this page, decides whether a request is made.
 * The API key is not here -- it lives in the protected secret store.
 * `backend` picks who answers: Jev (the default) or an open model.
 */
type JevSettingsState = {
  skillMode: JevMode
  rerankMode: JevMode
  backend: DecisionBackend
  setBackend: (backend: DecisionBackend) => void
  setSkillMode: (mode: JevMode) => void
  setRerankMode: (mode: JevMode) => void
}

export const JEV_SETTINGS_KEY = 'flint-jev'

export const useJevSettings = create<JevSettingsState>()(
  persist(
    (set) => ({
      skillMode: 'off',
      rerankMode: 'off',
      backend: JEV_BACKEND,
      setBackend: (backend) => set({ backend }),
      setSkillMode: (skillMode) => set({ skillMode }),
      setRerankMode: (rerankMode) => set({ rerankMode }),
    }),
    {
      name: JEV_SETTINGS_KEY,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) =>
        ({ skillMode: s.skillMode, rerankMode: s.rerankMode, backend: s.backend }) as unknown as JevSettingsState,
    }
  )
)
