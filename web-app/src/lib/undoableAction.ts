import { create } from 'zustand'
import { showUndoToast } from '@/lib/toastUndo'

/**
 * Deletes that wait a few seconds before they happen, with Undo on the toast.
 * While an item is pending it is hidden from the lists that read
 * `usePendingDeletes`; Undo shows it again and nothing was touched. If the
 * app closes during the wait the delete simply never happened.
 */
type PendingDeletes = {
  ids: Record<string, true>
  hide: (id: string) => void
  show: (id: string) => void
}

export const usePendingDeletes = create<PendingDeletes>()((set) => ({
  ids: {},
  hide: (id) => set((s) => ({ ids: { ...s.ids, [id]: true } })),
  show: (id) =>
    set((s) => {
      const next = { ...s.ids }
      delete next[id]
      return { ids: next }
    }),
}))

export const UNDO_WINDOW_MS = 6000

export function undoableDelete(opts: {
  id: string
  message: string
  description?: string
  undoLabel: string
  run: () => void | Promise<void>
  delayMs?: number
}) {
  const { hide, show } = usePendingDeletes.getState()
  hide(opts.id)
  let undone = false
  const timer = window.setTimeout(() => {
    if (undone) return
    void Promise.resolve(opts.run()).finally(() => show(opts.id))
  }, opts.delayMs ?? UNDO_WINDOW_MS)
  showUndoToast({
    message: opts.message,
    id: `undo-${opts.id}`,
    description: opts.description,
    durationMs: opts.delayMs ?? UNDO_WINDOW_MS,
    undoLabel: opts.undoLabel,
    onUndo: () => {
      undone = true
      window.clearTimeout(timer)
      show(opts.id)
    },
  })
}
