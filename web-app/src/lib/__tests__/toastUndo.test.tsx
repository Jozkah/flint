import { describe, it, expect, afterEach } from 'vitest'
import { toast } from 'sonner'
import { showUndoToast } from '../toastUndo'

afterEach(() => {
  toast.dismiss()
})

const opts = { message: 'Removed', undoLabel: 'Undo', onUndo: () => {} }

describe('showUndoToast ids', () => {
  it('returns the id the toast is actually stored under', () => {
    const id = showUndoToast(opts)
    // The id handed back is what dismiss(id) acts on; it must name the toast.
    expect(toast.getToasts().some((t) => t.id === id)).toBe(true)
  })

  it('keeps a caller-chosen id', () => {
    const id = showUndoToast({ ...opts, id: 'my-undo' })
    expect(id).toBe('my-undo')
    expect(toast.getToasts().some((t) => t.id === 'my-undo')).toBe(true)
  })

  it('two toasts without an id get two distinct stored ids', () => {
    const a = showUndoToast(opts)
    const b = showUndoToast(opts)
    expect(a).not.toBe(b)
    const ids = toast.getToasts().map((t) => t.id)
    expect(ids).toContain(a)
    expect(ids).toContain(b)
  })
})
