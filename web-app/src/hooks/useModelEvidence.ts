import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  MAX_RESULTS_PER_MODEL,
  resultKey,
  type ModelTestResult,
} from '@/lib/modelEvidence'

export interface PreferredModel {
  provider: string
  model: string
}

interface ModelEvidenceState {
  /** Measured compatibility results, newest first, keyed `provider:modelId`. */
  results: Record<string, ModelTestResult[]>
  /** The model a new conversation starts with, chosen by the user. */
  preferredModel: PreferredModel | null
  /** Models whose fit hint the user dismissed (`provider:modelId`). */
  dismissedHints: string[]

  addResult: (result: ModelTestResult) => void
  clearResults: (provider: string, modelId: string) => void
  setPreferredModel: (preferred: PreferredModel | null) => void
  dismissHint: (provider: string, modelId: string) => void
  restoreHint: (provider: string, modelId: string) => void
}

export const useModelEvidence = create<ModelEvidenceState>()(
  persist(
    (set) => ({
      results: {},
      preferredModel: null,
      dismissedHints: [],

      addResult: (result) =>
        set((state) => {
          const key = resultKey(result.provider, result.modelId)
          const next = [result, ...(state.results[key] ?? [])].slice(
            0,
            MAX_RESULTS_PER_MODEL
          )
          return { results: { ...state.results, [key]: next } }
        }),

      clearResults: (provider, modelId) =>
        set((state) => {
          const results = { ...state.results }
          delete results[resultKey(provider, modelId)]
          return { results }
        }),

      setPreferredModel: (preferredModel) => set({ preferredModel }),

      dismissHint: (provider, modelId) =>
        set((state) => {
          const key = resultKey(provider, modelId)
          return state.dismissedHints.includes(key)
            ? state
            : { dismissedHints: [...state.dismissedHints, key] }
        }),

      restoreHint: (provider, modelId) =>
        set((state) => ({
          dismissedHints: state.dismissedHints.filter(
            (k) => k !== resultKey(provider, modelId)
          ),
        })),
    }),
    {
      name: localStorageKey.modelEvidence,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
    }
  )
)
