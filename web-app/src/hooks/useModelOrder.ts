import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  DEFAULT_MODEL_SORT,
  modelUsageKey,
  type ModelSortOption,
} from '@/lib/modelSort'

/**
 * How the user wants models listed, and what "recently used" means.
 *
 * The two live together because the recency order is unusable without the
 * history that defines it. Both survive a restart: a chosen order that reset
 * itself every launch would not be a preference.
 */

/**
 * How many models keep a usage timestamp.
 *
 * The history exists only to order a list, so it never needs to remember
 * further back than a list is long. Without a bound it would accumulate an
 * entry for every model ever selected, including deleted ones.
 */
export const MAX_TRACKED_MODELS = 200

interface ModelOrderState {
  sort: ModelSortOption
  /** `provider:modelId` to the epoch millis it was last selected. */
  lastUsed: Record<string, number>
  setSort: (sort: ModelSortOption) => void
  /** Record that a model was just picked. `at` is injectable for tests. */
  markUsed: (providerName: string, modelId: string, at?: number) => void
}

/** The most recent `MAX_TRACKED_MODELS` entries, oldest dropped. */
function trim(lastUsed: Record<string, number>): Record<string, number> {
  const entries = Object.entries(lastUsed)
  if (entries.length <= MAX_TRACKED_MODELS) return lastUsed
  return Object.fromEntries(
    entries.sort(([, a], [, b]) => b - a).slice(0, MAX_TRACKED_MODELS)
  )
}

export const useModelOrder = create<ModelOrderState>()(
  persist(
    (set) => ({
      sort: DEFAULT_MODEL_SORT,
      lastUsed: {},

      setSort: (sort) => set({ sort }),

      markUsed: (providerName, modelId, at) =>
        set((state) => ({
          lastUsed: trim({
            ...state.lastUsed,
            [modelUsageKey(providerName, modelId)]: at ?? Date.now(),
          }),
        })),
    }),
    {
      name: localStorageKey.modelOrder,
      storage: createJSONStorage(() => backendStorage),
      // Async backend storage; hydrated explicitly after ServiceHub init.
      skipHydration: true,
      partialize: (state) => ({ sort: state.sort, lastUsed: state.lastUsed }),
    }
  )
)
