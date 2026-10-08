import { toast } from 'sonner'
import { UndoToast } from '@/components/UndoToast'

export const UNDO_TOAST_MS = 4000

export interface UndoToastOptions {
  message: string
  description?: string
  undoLabel: string
  onUndo: () => void
  durationMs?: number
  id?: string | number
}

/** A toast that offers Undo while an amber outline burns away around it. */
export function showUndoToast(opts: UndoToastOptions): string | number {
  const durationMs = opts.durationMs ?? UNDO_TOAST_MS
  return toast.custom(
    (toastId) => (
      <UndoToast
        toastId={toastId}
        message={opts.message}
        description={opts.description}
        undoLabel={opts.undoLabel}
        onUndo={opts.onUndo}
        durationMs={durationMs}
      />
    ),
    // The card dismisses itself when the burn ends, so sonner never times it out.
    { id: opts.id, duration: Infinity }
  )
}
