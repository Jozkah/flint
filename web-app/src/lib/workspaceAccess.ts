/**
 * What each attached folder's badge says, and where a session's writes land,
 * from the session's access and the user's per-folder read-only marks.
 */
import { sameFolder } from '@/lib/coworkFolders'

export type AccessMode = 'review-only' | 'managed-worktree' | 'edit-folder'

/** What a folder's badge says: read-only, editable, or edited via a worktree. */
export type FolderAccess = 'read-only' | 'editable' | 'worktree'

/** Where writes land: a folder access, or only the editable extras. */
export type WritesKind = FolderAccess | 'extras'

/** The primary folder's access under `access`. */
export const primaryFolderAccess = (access?: AccessMode): FolderAccess =>
  access === 'edit-folder'
    ? 'editable'
    : access === 'managed-worktree'
      ? 'worktree'
      : 'read-only'

export type WorkspaceAccessInput = {
  access: AccessMode
  extraFolders: readonly string[]
  extraFoldersWritable: boolean
  readOnlyExtraFolders: readonly string[]
  mainFolderReadOnly: boolean
  canToggleExtraWritable: boolean
  canToggleMainWritable: boolean
}

export type WorkspaceAccess = {
  primaryAccess: FolderAccess
  extraAccess: (extra: string) => FolderAccess
  canToggleExtras: boolean
  canToggleMain: boolean
  writesKind: WritesKind
}

export function workspaceAccess({
  access,
  extraFolders,
  extraFoldersWritable,
  readOnlyExtraFolders,
  mainFolderReadOnly,
  canToggleExtraWritable,
  canToggleMainWritable,
}: WorkspaceAccessInput): WorkspaceAccess {
  // Each folder has its own mark. Under Edit this folder the main folder can
  // be read-only while an extra is editable; the session is Review only
  // only when no folder is editable.
  const primaryAccess: FolderAccess =
    access === 'edit-folder' && mainFolderReadOnly
      ? 'read-only'
      : primaryFolderAccess(access)
  // Whether the session's access lets extra folders be edited at all; each
  // one is then editable unless the user marked it read-only.
  const extrasCanEdit = access !== 'review-only' && extraFoldersWritable
  const extraMarkedReadOnly = (extra: string) =>
    readOnlyExtraFolders.some((one) => sameFolder(one, extra))
  const extraAccess = (extra: string): FolderAccess =>
    extrasCanEdit && !extraMarkedReadOnly(extra) ? 'editable' : 'read-only'
  const canToggleExtras = extraFoldersWritable && canToggleExtraWritable
  // A worktree is the main folder's own way of being edited: no toggle there.
  const canToggleMain =
    extraFoldersWritable && canToggleMainWritable && primaryAccess !== 'worktree'
  const someExtraEditable = extraFolders.some(
    (extra) => extraAccess(extra) === 'editable'
  )
  // Where writes land: the main folder, its worktree, only the editable
  // extras, or the sandbox when nothing is editable.
  const writesKind: WritesKind =
    primaryAccess === 'read-only' && someExtraEditable ? 'extras' : primaryAccess
  return { primaryAccess, extraAccess, canToggleExtras, canToggleMain, writesKind }
}
