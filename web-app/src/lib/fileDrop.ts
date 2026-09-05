/**
 * Where a dropped file goes.
 *
 * Two targets want files and mean opposite things by them: the code panel
 * opens a file to read, the composer attaches it to a message. Ambiguity here
 * is not resolvable by guessing, so it is resolved by aim — each target owns
 * its own zone and says what it will do while you hover it.
 *
 * A directory is neither. Recursively ingesting one as an attachment is the
 * kind of thing that reads a hundred files nobody asked about, so a folder is
 * offered as the project instead, and only after the user confirms.
 */

export type DropTarget = 'code' | 'composer'

export type DropIntent =
  /** Open these files read-only in the code panel. */
  | { action: 'open'; files: File[] }
  /** Attach these files to the message being composed. */
  | { action: 'attach'; files: File[] }
  /** Offer to attach this folder as the project. Never ingested. */
  | { action: 'offer-folder'; name: string }
  /** Nothing usable was dropped. */
  | { action: 'ignore' }

/**
 * A directory, as far as a drop event can tell.
 *
 * Browsers report a folder as a zero-size entry with no type. It is a
 * heuristic because `DataTransferItem.webkitGetAsEntry` is not available in
 * every path this runs through, so the check is deliberately conservative:
 * a real file with no extension and no type is rare, and being asked about a
 * folder that was a file is a smaller harm than silently reading a tree.
 */
export function looksLikeDirectory(file: {
  name: string
  size: number
  type: string
}): boolean {
  return file.size === 0 && file.type === '' && !file.name.includes('.')
}

/**
 * What to do with what was dropped on `target`.
 *
 * A folder wins over files in the same drop: mixing "open these three files
 * and also switch your project" into one gesture is not something the user
 * can have meant.
 */
export function decideDrop(target: DropTarget, files: File[]): DropIntent {
  if (files.length === 0) return { action: 'ignore' }

  const folder = files.find(looksLikeDirectory)
  if (folder) return { action: 'offer-folder', name: folder.name }

  return target === 'code'
    ? { action: 'open', files }
    : { action: 'attach', files }
}

/** Does this drag carry files at all, as opposed to text or a selection? */
export function dragHasFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  if (transfer.types?.includes?.('Files')) return true
  return (transfer.files?.length ?? 0) > 0
}

/**
 * The classes marking a zone as the one about to receive the drop.
 *
 * Each target gets a visibly different treatment, so a hover says which of the
 * two things is about to happen without reading the label.
 */
export const DROP_ZONE_CLASS: Record<DropTarget, string> = {
  code: 'ring-2 ring-inset ring-primary/50 bg-primary/[0.06]',
  composer: 'ring-2 ring-inset ring-emerald-500/50 bg-emerald-500/[0.06]',
}

/** The i18n key for what this zone will do with the drop. */
export const dropLabelKey = (target: DropTarget): string =>
  target === 'code' ? 'common:drop.openInCode' : 'common:drop.attachToMessage'

/**
 * Is the user typing right now?
 *
 * A global shortcut that fires while someone is mid-sentence in the composer
 * is a bug, not a feature — and an open dialog owns the keyboard until it is
 * dismissed. Checked against the real focused element rather than a flag, so
 * it stays true for anything focusable that takes text.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable) return true
  const tag = el.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  // Inside an open dialog or a menu, the shortcut is not ours to take.
  return Boolean(el.closest('[role="dialog"], [role="menu"], [contenteditable="true"]'))
}
