// The Cowork run store's panel requests and model loading state.

import type { StoreApi } from 'zustand'
import type { CoworkRunState, SetRun } from './types'
import { omitKey } from './turns'

/** Requests between panels, and the per-session model loading state. */
export const runRequestsSlice = (
  set: SetRun,
  get: StoreApi<CoworkRunState>['getState']
): Pick<
  CoworkRunState,
  | 'requestPreview'
  | 'clearPendingPreview'
  | 'requestCodeOpen'
  | 'clearPendingCodeOpen'
  | 'requestAttachFolder'
  | 'clearAttachFolderRequest'
  | 'setLlamacppRun'
  | 'clearLlamacppRun'
  | 'setPendingLlamacppError'
  | 'takePendingLlamacppError'
  | 'setSessionLoadingModel'
  | 'setSessionModelLoadProgress'
> => ({
  requestPreview: (sessionId, path) => set({ pendingPreview: { sessionId, path } }),
  clearPendingPreview: () => set({ pendingPreview: null }),
  requestCodeOpen: (sessionId, path, as) =>
    set({ pendingCodeOpen: { sessionId, path, as } }),
  clearPendingCodeOpen: () => set({ pendingCodeOpen: null }),
  requestAttachFolder: () => set({ attachFolderRequested: true }),
  clearAttachFolderRequest: () => set({ attachFolderRequested: false }),

  setLlamacppRun: (sid, modelId) =>
    set((s) => ({ llamacppRuns: { ...s.llamacppRuns, [sid]: modelId } })),
  clearLlamacppRun: (sid) =>
    set((s) => ({ llamacppRuns: omitKey(s.llamacppRuns, sid) })),
  setPendingLlamacppError: (sid, message) =>
    set((s) => ({
      pendingLlamacppError: { ...s.pendingLlamacppError, [sid]: message },
    })),
  takePendingLlamacppError: (sid) => {
    const message = get().pendingLlamacppError[sid]
    if (message !== undefined) {
      set((s) => ({ pendingLlamacppError: omitKey(s.pendingLlamacppError, sid) }))
    }
    return message
  },
  setSessionLoadingModel: (sid, loading) =>
    set((s) => {
      const next = { ...s.loadingModels }
      if (loading) next[sid] = true
      else delete next[sid]
      return { loadingModels: next }
    }),
  setSessionModelLoadProgress: (sid, progress) =>
    set((s) => {
      const next = { ...s.modelLoadProgress }
      if (progress) next[sid] = progress
      else delete next[sid]
      return { modelLoadProgress: next }
    }),
})
