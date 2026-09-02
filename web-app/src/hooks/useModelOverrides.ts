import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  NO_OVERRIDES,
  clearOverride,
  hasOverrides,
  pruneOverrides,
  setOverride,
  type ModelOverrides,
  type ModelSettingValue,
} from '@/lib/modelOverrides'

/**
 * Each chat's model-setting overrides, keyed by thread id.
 *
 * Deliberately its own store rather than a field on the thread. A thread is
 * written back through the threads service on almost every interaction, and a
 * settings blob riding along would be rewritten with it — the surest way to
 * end up with a stale copy of the global defaults baked into every chat. Here
 * the record holds only what a chat actually changed, and is written only when
 * that changes.
 *
 * A chat with no entry is the normal case and costs nothing: it simply uses
 * the global model configuration.
 */
type ModelOverridesState = {
  /** Sparse, per thread. A thread absent here overrides nothing. */
  byThread: Record<string, ModelOverrides>

  /** This chat's overrides, or the shared empty set. */
  forThread: (threadId: string | null | undefined) => ModelOverrides
  /** Override one setting for one chat. */
  setForThread: (
    threadId: string,
    key: string,
    value: ModelSettingValue
  ) => void
  /** Give one setting back to the global default. */
  clearForThread: (threadId: string, key: string) => void
  /** Give every setting back to the global defaults. */
  resetThread: (threadId: string) => void
  /** Drop overrides naming settings the chat's model no longer defines. */
  pruneForThread: (threadId: string, model: Model | null | undefined) => void
  /** Forget a chat that no longer exists. */
  dropThread: (threadId: string) => void
}

/** Remove a thread's entry entirely rather than leaving an empty object. */
const without = (
  byThread: Record<string, ModelOverrides>,
  threadId: string
): Record<string, ModelOverrides> => {
  if (!(threadId in byThread)) return byThread
  const next = { ...byThread }
  delete next[threadId]
  return next
}

export const useModelOverrides = create<ModelOverridesState>()(
  persist(
    (set, get) => ({
      byThread: {},

      forThread: (threadId) =>
        (threadId ? get().byThread[threadId] : undefined) ?? NO_OVERRIDES,

      setForThread: (threadId, key, value) =>
        set((s) => ({
          byThread: {
            ...s.byThread,
            [threadId]: setOverride(s.byThread[threadId], key, value),
          },
        })),

      clearForThread: (threadId, key) =>
        set((s) => {
          const next = clearOverride(s.byThread[threadId], key)
          // An empty set is no set: keeping `{}` around would make a chat that
          // has been reset look different from one that never changed anything.
          return {
            byThread: hasOverrides(next)
              ? { ...s.byThread, [threadId]: next }
              : without(s.byThread, threadId),
          }
        }),

      resetThread: (threadId) =>
        set((s) =>
          hasOverrides(s.byThread[threadId])
            ? { byThread: without(s.byThread, threadId) }
            : { byThread: s.byThread }
        ),

      pruneForThread: (threadId, model) =>
        set((s) => {
          const current = s.byThread[threadId]
          if (!hasOverrides(current)) return { byThread: s.byThread }
          const pruned = pruneOverrides(model, current)
          if (pruned === current) return { byThread: s.byThread }
          return {
            byThread: hasOverrides(pruned)
              ? { ...s.byThread, [threadId]: pruned }
              : without(s.byThread, threadId),
          }
        }),

      dropThread: (threadId) =>
        set((s) => ({ byThread: without(s.byThread, threadId) })),
    }),
    {
      name: localStorageKey.modelOverrides,
      // Through the Rust settings store, like the other migrated stores, so
      // this lives in <jan_data>/settings.json rather than webview
      // localStorage. Async storage requires skipHydration plus an explicit
      // rehydrate in hydrateBackendStores().
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      version: 1,
      // Only the record is persisted; the actions are rebuilt on load.
      partialize: (state) => ({ byThread: state.byThread }),
    }
  )
)
