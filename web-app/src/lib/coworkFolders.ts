/**
 * A Cowork session's attached folders, like a multi-root workspace.
 *
 * `folder` stays the primary: the one the shell starts in, the one a managed
 * worktree is made from, and the only one sessions saved before this existed
 * have. `extraFolders` is an ordered list beside it. Sessions on disk without
 * the field have no extra folders, so they need no migration step.
 */

/** A spelling two paths can be compared by: separators, trailing slash, case. */
const folderKey = (path: string): string => {
  const unified = path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  // Drive-letter paths are Windows paths, whose case does not matter.
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified
}

export const sameFolder = (a: string, b: string): boolean =>
  folderKey(a) === folderKey(b)

/** The session's extra folders, never the primary, never twice. */
export function extraFoldersOf(session: {
  folder: string | null
  extraFolders?: readonly string[]
}): string[] {
  const out: string[] = []
  for (const extra of session.extraFolders ?? []) {
    if (!extra.trim()) continue
    if (session.folder && sameFolder(extra, session.folder)) continue
    if (out.some((one) => sameFolder(one, extra))) continue
    out.push(extra)
  }
  return out
}

/**
 * The extra folders a write grant may cover: every extra folder except those
 * the user marked read-only. Absent marks keep the old behaviour (all of
 * them), so sessions saved before per-folder access need no migration.
 */
export function writableExtraFoldersOf(session: {
  folder: string | null
  extraFolders?: readonly string[]
  readOnlyExtraFolders?: readonly string[]
}): string[] {
  const readOnly = session.readOnlyExtraFolders ?? []
  return extraFoldersOf(session).filter(
    (extra) => !readOnly.some((one) => sameFolder(one, extra))
  )
}

/**
 * Whether the user marked the main folder read-only. Absent (every session
 * saved before per-folder access) is derived from the access mode, so old
 * sessions keep what they had: read-only exactly under Review only. A managed
 * worktree is never read-only here; its writes go to the worktree.
 */
export function mainFolderReadOnlyOf(session: {
  access?: string
  mainFolderReadOnly?: boolean
}): boolean {
  if (session.access === 'managed-worktree') return false
  // A session with no access recorded is Review only (see `accessOf`).
  return (
    session.mainFolderReadOnly ??
    (session.access ?? 'review-only') === 'review-only'
  )
}

/**
 * A run's prompt access for the main folder, with the user's read-only mark
 * applied: an `editable` session whose main folder is marked read-only is
 * told that folder is read-only (its grant does not cover it).
 */
export function withMainFolderMark<T extends string>(
  access: T | 'read-only',
  session:
    | { access?: string; mainFolderReadOnly?: boolean }
    | null
    | undefined
): T | 'read-only' {
  return access === 'editable' && session && mainFolderReadOnlyOf(session)
    ? 'read-only'
    : access
}

/** `extras` with `folder` appended, unless it is already attached. */
export function withExtraFolder(
  primary: string | null,
  extras: readonly string[],
  folder: string
): string[] {
  return extraFoldersOf({ folder: primary, extraFolders: [...extras, folder] })
}

/** `extras` without `folder`. */
export function withoutExtraFolder(
  extras: readonly string[],
  folder: string
): string[] {
  return extras.filter((one) => !sameFolder(one, folder))
}

/** Is `path` inside `root` (or `root` itself)? */
export function isInsideFolder(root: string, path: string): boolean {
  const r = folderKey(root)
  const p = folderKey(path)
  return r.length > 0 && (p === r || p.startsWith(`${r}/`))
}

/** Is `path` inside any of `roots`? */
export const isInsideAnyFolder = (
  roots: readonly string[],
  path: string
): boolean => roots.some((root) => isInsideFolder(root, path))
