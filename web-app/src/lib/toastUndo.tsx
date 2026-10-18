import { toast } from 'sonner'
import { UndoToast } from '@/components/UndoToast'

export const UNDO_TOAST_MS = 4000
/** Grace past the burn before sonner removes a card that did not remove itself. */
export const UNDO_TOAST_BACKSTOP_MS = 1500

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
    // The card dismisses itself when the burn ends; sonner's own timer is a
    // backstop for when that never runs (a paused timer, a card that was
    // re-mounted), so an Undo can never outlive its offer.
    // `id` is only present when given: sonner spreads these options over the
    // id it just made, so an explicit `id: undefined` replaced it and the id
    // handed back (and to the card) named no toast -- dismiss(id) did nothing.
    {
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      duration: durationMs + UNDO_TOAST_BACKSTOP_MS,
    }
  )
}
