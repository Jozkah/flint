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

/**
 * An absolute file-system path, if that is all `text` is.
 *
 * Pasted text is only a path when it is one line and unmistakably absolute: a
 * drive path (never UNC), or a POSIX path with at least two segments (so `/clear`
 * stays a command). A URL is never a path. Surrounding quotes, which a shell
 * "copy as path" adds, are stripped. Whether it exists is the caller's check.
 */
export function pastedPath(text: string): string | null {
  let s = text.trim()
  if (!s || s.length > 1024 || /[\r\n]/.test(s)) return null
  const quoted = /^(["'])(.*)\1$/.exec(s)
  if (quoted) s = quoted[2].trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null
  const windows = /^[A-Za-z]:[\\/][^\\/]/.test(s)
  const posix = /^\/[^/\s][^/]*\/[^/]/.test(s)
  // A UNC path (backslash pair or `//host/x`) is never offered: stat'ing it
  // makes Windows connect to that host and offer NTLM credentials.
  if (!isSafeLocalPath(s)) return null
  return windows || posix ? s : null
}

/**
 * `draft` without the last pasted copy of `path` (as pasted, quoted, or with
 * the composer's Markdown escapes), for when the path was attached instead.
 * Returns the draft unchanged when the path is not in it.
 */
export function withoutPastedPath(draft: string, path: string): string {
  if (!path) return draft
  const body = Array.from(path)
    .map((c) =>
      /[\\`*_{}[\]()#+\-.!|<>~]/.test(c)
        ? `\\\\?${c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}`
        : c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
    )
    .join('')
  const re = new RegExp(`(["']?)${body}\\1`, 'g')
  let last: RegExpExecArray | null = null
  for (let m = re.exec(draft); m; m = re.exec(draft)) last = m
  if (!last) return draft
  const before = draft.slice(0, last.index).replace(/[ \t]+$/, '')
  const after = draft.slice(last.index + last[0].length).replace(/^[ \t]+/, '')
  return (before && after ? `${before} ${after}` : before + after).trim()
}

/**
 * The local paths in a `file://` URI list, when that is all `text` is.
 *
 * Linux file managers put dragged or copied files on the clipboard and drag
 * data as `text/uri-list` / `text/plain` URIs with no File objects, so the
 * composer would insert the raw `file:///home/me/a%20b.png` as text. One URI
 * per line (`#` lines are comments, per RFC 2483). Returns null unless every
 * line is a `file:` URI, so ordinary pasted text is never touched.
 */
export function fileUriPaths(text: string): string[] | null {
  const lines = splitLines(text).filter((l) => !l.startsWith('#'))
  if (lines.length === 0 || lines.length > 50) return null
  const paths: string[] = []
  for (const line of lines) {
    const path = fileUriPath(line)
    if (path === null) return null
    paths.push(path)
  }
  return paths
}

/** Lines of `text`, trimmed, without blanks or the NUL some tools append. */
function splitLines(text: string): string[] {
  return text
    .split('\u0000')
    .join('')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

/** One `file:` URI as a local path, or null. Accepts `file:/p` and localhost. */
function fileUriPath(line: string): string | null {
  const m = /^file:(?:\/\/([^/]*))?(\/.*)$/i.exec(line)
  if (!m || (m[1] && m[1].toLowerCase() !== 'localhost')) return null
  // A stray `%` (a file literally named `100%.txt`) must not lose the file.
  let path = m[2].replace(/(%[0-9A-Fa-f]{2})+/g, (seq) => {
    try {
      return decodeURIComponent(seq)
    } catch {
      return seq
    }
  })
  // file:///C:/dir/a.png -> C:/dir/a.png
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
  if (!isSafeLocalPath(path)) return null
  // Strip a trailing slash, but keep a root (`/`, `C:/`) whole.
  if (!/^([A-Za-z]:)?[\\/]$/.test(path)) path = path.replace(/[\\/]+$/, '')
  return path
}

/**
 * A local path that cannot reach the network or climb out of where it points.
 *
 * `//host/share` and `\\host\share` are UNC paths on Windows: reading one makes
 * the OS connect to that host (and offer NTLM credentials), so a drop or paste
 * must never produce one. `..` segments and NUL bytes are refused outright.
 */
function isSafeLocalPath(path: string): boolean {
  if (/^[\\/]{2}/.test(path)) return false
  if (path.includes('\u0000')) return false
  return !path.split(/[\\/]/).some((seg) => seg === '..')
}

/** The part of DataTransfer this module reads; lets tests pass plain objects. */
export type TransferLike = {
  types?: ReadonlyArray<string> | null
  getData: (type: string) => string
}

function readType(transfer: TransferLike, type: string): string {
  try {
    return transfer.getData(type) ?? ''
  } catch {
    return ''
  }
}

/** `copy`/`cut` headers GNOME (and the old Nautilus text/plain hack) prepend. */
const COPIED_FILES_HEADER = /^(x-special\/nautilus-clipboard|copy|cut)$/i

/** Only the `file:` lines of `text`, if there is at least one and no prose. */
function copiedFileLines(text: string, skipOdd = false): string[] | null {
  let lines = splitLines(text).filter((l) => !COPIED_FILES_HEADER.test(l))
  // text/x-moz-url is url, title, url, title...
  if (skipOdd) lines = lines.filter((_, i) => i % 2 === 0)
  return lines.length > 0 ? fileUriPaths(lines.join('\n')) : null
}

/** Every line an absolute path (quotes stripped), as a file manager's text. */
function barePaths(text: string): string[] | null {
  const lines = splitLines(text)
  if (lines.length === 0 || lines.length > 50) return null
  const paths: string[] = []
  for (const line of lines) {
    const p = pastedPath(line)
    if (!p || !isSafeLocalPath(p)) return null
    paths.push(p)
  }
  return paths
}

/**
 * Local files a drop or paste names as text, whatever MIME type carried them.
 *
 * Linux file managers do not agree: GNOME Files offers `text/uri-list` and
 * `x-special/gnome-copied-files` (`copy\nfile:///…`), older Nautilus puts the
 * same `x-special/nautilus-clipboard` block in `text/plain`, KDE Dolphin and
 * Thunar/PCManFM offer `text/uri-list` and `file://` text, Firefox-style
 * sources use `text/x-moz-url`. WebKitGTK only exposes some of these to the
 * page and, from 2.52, may send no File objects at all, so every one is tried.
 *
 * Bare absolute paths in `text/plain` only count when `allowBarePaths` (a
 * drop): a pasted path stays text and is offered instead.
 */
export function transferFilePaths(
  transfer: TransferLike | null | undefined,
  { allowBarePaths = false }: { allowBarePaths?: boolean } = {}
): string[] | null {
  if (!transfer) return null
  const plain = readType(transfer, 'text/plain')
  const candidates = [
    fileUriPaths(readType(transfer, 'text/uri-list')),
    copiedFileLines(readType(transfer, 'x-special/gnome-copied-files')),
    copiedFileLines(readType(transfer, 'text/x-moz-url'), true),
    copiedFileLines(plain),
    allowBarePaths ? barePaths(plain) : null,
  ]
  const found = candidates.find((c) => c && c.length > 0)
  return found ? [...new Set(found)] : null
}

/**
 * Files named by a paste or a drop, and whether that naming can be trusted.
 *
 * One trust model for both. Any web page can put `file:///home/me/.bashrc`, or
 * a bare `/home/me/.ssh/id_rsa`, in text/plain or text/uri-list from a copy
 * handler or a draggable link, so only GNOME's `x-special/gnome-copied-files`
 * (which a page cannot write) is trusted to attach on its own. Anything else
 * must be confirmed by the user first. Null when real File objects came with
 * it (use those) or nothing names a file.
 *
 * Bare paths in text/plain are accepted only for a drop (`allowBarePaths`),
 * and are never trusted.
 */
export function namedFilePaths(
  transfer: (TransferLike & { files?: { length: number } | null }) | null | undefined,
  { allowBarePaths = false }: { allowBarePaths?: boolean } = {}
): { paths: string[]; trusted: boolean } | null {
  if (!transfer || (transfer.files?.length ?? 0) > 0) return null
  const gnome = copiedFileLines(readType(transfer, 'x-special/gnome-copied-files'))
  if (gnome?.length) return { paths: [...new Set(gnome)], trusted: true }
  const paths = transferFilePaths(transfer, { allowBarePaths })
  return paths ? { paths, trusted: false } : null
}

/** A paste's named files (see `namedFilePaths`). */
export const pasteFilePaths = (
  transfer: Parameters<typeof namedFilePaths>[0]
): { paths: string[]; trusted: boolean } | null => namedFilePaths(transfer)

/**
 * Whether a drag started inside this window is in flight. Content rendered in
 * the app (a message, an HTML preview) can set any type on its own drag,
 * including the GNOME one, so a drop that began in-app never names trusted
 * files: only a drag the user brought in from outside does.
 */
let inAppDrag = false
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('dragstart', () => (inAppDrag = true), true)
  const end = () => (inAppDrag = false)
  document.addEventListener('dragend', end, true)
  document.addEventListener('drop', () => setTimeout(end, 0), true)
}

/** Test seam: pretend a drag started (or ended) in this window. */
export function setInAppDragForTest(active: boolean): void {
  inAppDrag = active
}

/** A drop's named files (see `namedFilePaths`). */
export const dropFilePaths = (
  transfer: Parameters<typeof namedFilePaths>[0]
): { paths: string[]; trusted: boolean } | null => {
  const named = namedFilePaths(transfer, { allowBarePaths: true })
  return named && inAppDrag ? { ...named, trusted: false } : named
}

/** The text a paste or drop carried, to put back if the user declines to attach it. */
export function transferText(transfer: TransferLike | null | undefined): string {
  if (!transfer) return ''
  return readType(transfer, 'text/plain') || readType(transfer, 'text/uri-list')
}

/** Does this drag carry files at all, as opposed to text or a selection? */
export function dragHasFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false
  const types = transfer.types
  if (types?.includes?.('Files')) return true
  if ((transfer.files?.length ?? 0) > 0) return true
  // WebKitGTK may hand a file-manager drag over as a bare uri-list. Only a
  // readable `file:` list counts: a browser address-bar drag is a uri-list
  // too. Unreadable (protected dragover data) falls back to Files-only.
  if (types?.includes?.('x-special/gnome-copied-files')) return true
  if (!types?.includes?.('text/uri-list') || types.includes('text/html')) return false
  return fileUriPaths(readType(transfer, 'text/uri-list')) !== null
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

/**
 * Dropped files as fenced blocks for a text-only composer (Rooms).
 *
 * A room message is plain text, so a file can only be sent as its contents.
 * Anything that is not text (an image, an archive, a file with a NUL byte) is
 * skipped and named, and the whole result stays within `budget` characters
 * so the message can still be sent.
 */
export function inlineDroppedTexts(
  items: Array<{ name: string; text: string }>,
  budget: number
): { text: string; skipped: string[] } {
  const blocks: string[] = []
  const skipped: string[] = []
  let used = 0
  for (const { name, text } of items) {
    if (text.includes('\u0000')) {
      skipped.push(name)
      continue
    }
    // Backticks unless the text has a run of three; then tildes, one longer
    // than the longest tilde run in the text.
    const longestRun = (ch: string) =>
      (text.match(new RegExp(`${ch}+`, 'g')) ?? []).reduce(
        (n, run) => Math.max(n, run.length),
        0
      )
    const fence =
      longestRun('`') >= 3
        ? '~'.repeat(Math.max(4, longestRun('~') + 1))
        : '```'
    const head = name + '\n' + fence + '\n'
    const tail = '\n' + fence
    const room = budget - used - head.length - tail.length - 2
    if (room <= 0) {
      skipped.push(name)
      continue
    }
    let body = text.length > room ? text.slice(0, room) : text
    // Never end on half of a surrogate pair.
    if (body.length < text.length && /[\uD800-\uDBFF]$/.test(body)) {
      body = body.slice(0, -1)
    }
    const block = head + body + tail
    blocks.push(block)
    used += block.length + 2
  }
  return { text: blocks.join('\n\n'), skipped }
}
