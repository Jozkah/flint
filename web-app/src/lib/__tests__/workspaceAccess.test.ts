import { describe, expect, it } from 'vitest'
import {
  primaryFolderAccess,
  workspaceAccess,
  type WorkspaceAccessInput,
} from '../workspaceAccess'

const base: WorkspaceAccessInput = {
  access: 'review-only',
  extraFolders: [],
  extraFoldersWritable: false,
  readOnlyExtraFolders: [],
  mainFolderReadOnly: false,
  canToggleExtraWritable: false,
  canToggleMainWritable: false,
}

describe('primaryFolderAccess', () => {
  it('maps each access mode, defaulting to read-only', () => {
    expect(primaryFolderAccess('edit-folder')).toBe('editable')
    expect(primaryFolderAccess('managed-worktree')).toBe('worktree')
    expect(primaryFolderAccess('review-only')).toBe('read-only')
    expect(primaryFolderAccess()).toBe('read-only')
  })
})

describe('workspaceAccess', () => {
  it('writes to the sandbox under Review only', () => {
    const a = workspaceAccess({ ...base, extraFolders: ['/b'] })
    expect(a.primaryAccess).toBe('read-only')
    expect(a.extraAccess('/b')).toBe('read-only')
    expect(a.writesKind).toBe('read-only')
  })

  it('writes only to editable extras when the main folder is marked read-only', () => {
    const a = workspaceAccess({
      ...base,
      access: 'edit-folder',
      mainFolderReadOnly: true,
      extraFolders: ['/b', '/c'],
      extraFoldersWritable: true,
      readOnlyExtraFolders: ['/c'],
    })
    expect(a.primaryAccess).toBe('read-only')
    expect(a.extraAccess('/b')).toBe('editable')
    expect(a.extraAccess('/c')).toBe('read-only')
    expect(a.writesKind).toBe('extras')
  })

  it('ignores the main read-only mark in a worktree and offers no main toggle', () => {
    const a = workspaceAccess({
      ...base,
      access: 'managed-worktree',
      mainFolderReadOnly: true,
      extraFoldersWritable: true,
      canToggleMainWritable: true,
      canToggleExtraWritable: true,
    })
    expect(a.primaryAccess).toBe('worktree')
    expect(a.writesKind).toBe('worktree')
    expect(a.canToggleMain).toBe(false)
    expect(a.canToggleExtras).toBe(true)
  })

  it('offers toggles only where a grant can cover extra folders', () => {
    const a = workspaceAccess({
      ...base,
      access: 'edit-folder',
      canToggleMainWritable: true,
      canToggleExtraWritable: true,
    })
    expect(a.canToggleMain).toBe(false)
    expect(a.canToggleExtras).toBe(false)
    expect(a.writesKind).toBe('editable')
  })
})
