// Writing a thread to the backend, rolling the store back when it fails.

import type { StoreApi } from 'zustand'
import { toast } from 'sonner'
import { i18n } from '@/i18n/react-i18next-compat'
import { getServiceHub } from '@/hooks/useServiceHub'
import type { ThreadState } from './types'

/**
 * Persist a thread write without an unhandled rejection. On failure the
 * optimistic state is rolled back to `prev`, but only while the store still
 * holds `next`: a newer edit (or a delete) made since must not be undone.
 * The caller therefore has to store the very object it persists. The user is
 * told either way.
 */
export function persistThread(
  set: StoreApi<ThreadState>['setState'],
  next: Thread,
  prev?: Thread
) {
  Promise.resolve()
    .then(() => getServiceHub().threads().updateThread(next))
    .catch((error) => {
      console.error('Failed to persist thread update:', error)
      toast.error(i18n.t('common:threadSaveFailed'))
      if (!prev) return
      set((state) =>
        state.threads[prev.id] === next
          ? { threads: { ...state.threads, [prev.id]: prev } }
          : state
      )
    })
}
