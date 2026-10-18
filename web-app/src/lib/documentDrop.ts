import { dragHasFiles } from '@/lib/fileDrop'

/** Text fields and contenteditable hosts take a dropped text/URL natively. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') {
    return false
  }
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  return !!el.closest(
    'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
  )
}

/**
 * Whether the document-level drop guard must cancel this drop.
 *
 * The guard exists so a file dropped outside a drop zone never makes the
 * webview navigate to (open) that file, and a link dropped on the page never
 * navigates it either. A text or URL dragged onto an editable field must
 * pass: cancelling it there swallows the drop (the field inserts nothing).
 * Drop zones handle and cancel their own drops before this runs.
 */
export function shouldBlockDocumentDrop(event: DragEvent): boolean {
  if (dragHasFiles(event.dataTransfer)) return true
  return !isEditableTarget(event.target)
}
