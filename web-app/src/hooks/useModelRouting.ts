import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { backendStorage } from '@/lib/backendStorage'

/**
 * How Jev may pick the AI model for a message.
 *
 * - `off`: the model you chose is always used.
 * - `ask`: Jev compares the model in use with your list for each new message and,
 *   only when another is clearly better, asks whether to switch for that message.
 * - `auto`: Jev switches for that message without asking, and the reply names
 *   the model that answered.
 */
export type ModelRoutingMode = 'off' | 'ask' | 'auto'

/** A model Jev may choose, and what you want Jev to know about it. */
export type RoutedModelRef = { provider: string; model: string; note?: string }

type ModelRoutingState = {
  mode: ModelRoutingMode
  pool: RoutedModelRef[]
  setMode: (mode: ModelRoutingMode) => void
  /** Add or remove a model from the list Jev chooses from. */
  setIncluded: (provider: string, model: string, included: boolean) => void
  setNote: (provider: string, model: string, note: string) => void
}

export const MODEL_ROUTING_KEY = 'flint-model-routing'
/** The longest note kept, so what is sent to Jev stays small. */
export const MAX_NOTE_CHARS = 120

export const useModelRouting = create<ModelRoutingState>()(
  persist(
    (set) => ({
      mode: 'off',
      pool: [],
      setMode: (mode) => set({ mode }),
      setIncluded: (provider, model, included) =>
        set((s) => {
          const rest = s.pool.filter((m) => !(m.provider === provider && m.model === model))
          if (!included) return { pool: rest }
          const kept = s.pool.find((m) => m.provider === provider && m.model === model)
          return { pool: [...rest, kept ?? { provider, model }] }
        }),
      setNote: (provider, model, note) =>
        set((s) => ({
          pool: s.pool.map((m) =>
            m.provider === provider && m.model === model
              ? { ...m, note: note.slice(0, MAX_NOTE_CHARS) || undefined }
              : m
          ),
        })),
    }),
    {
      name: MODEL_ROUTING_KEY,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      partialize: (s) => ({ mode: s.mode, pool: s.pool }) as unknown as ModelRoutingState,
    }
  )
)
