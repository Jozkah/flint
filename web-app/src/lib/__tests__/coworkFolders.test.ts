import { describe, expect, it } from 'vitest'
import {
  extraFoldersOf,
  isInsideAnyFolder,
  mainFolderReadOnlyOf,
  sameFolder,
  withMainFolderMark,
  withExtraFolder,
  withoutExtraFolder,
  writableExtraFoldersOf,
} from '../coworkFolders'
import { buildCoworkSystemPrompt } from '../coworkPrompt'

describe('a session’s extra folders', () => {
  it('are none on a session saved before they existed', () => {
    expect(extraFoldersOf({ folder: '/repo/a' })).toEqual([])
  })

  it('never list the primary, a blank or the same folder twice', () => {
    expect(
      extraFoldersOf({
        folder: 'C:\\repo\\a',
        extraFolders: ['c:/repo/a/', 'C:\\repo\\b', '', 'c:\\REPO\\b\\', '/x'],
      })
    ).toEqual(['C:\\repo\\b', '/x'])
  })

  it('are added in order and removed by any spelling', () => {
    const one = withExtraFolder('/a', [], '/b')
    const two = withExtraFolder('/a', one, '/c')
    expect(two).toEqual(['/b', '/c'])
    expect(withExtraFolder('/a', two, '/a')).toEqual(['/b', '/c'])
    expect(withoutExtraFolder(two, '/b/')).toEqual(['/c'])
  })

  it('compare case-insensitively only on Windows paths', () => {
    expect(sameFolder('C:\\Repo', 'c:/repo')).toBe(true)
    expect(sameFolder('/Repo', '/repo')).toBe(false)
  })

  it('are all writable unless marked read-only, by any spelling', () => {
    const session = { folder: '/a', extraFolders: ['/b', '/c'] }
    expect(writableExtraFoldersOf(session)).toEqual(['/b', '/c'])
    expect(
      writableExtraFoldersOf({ ...session, readOnlyExtraFolders: ['/c/'] })
    ).toEqual(['/b'])
  })

  it('contain paths under them, not siblings sharing a prefix', () => {
    const roots = ['C:\\work\\b', '/home/u/c']
    expect(isInsideAnyFolder(roots, 'C:\\work\\b\\src\\x.ts')).toBe(true)
    expect(isInsideAnyFolder(roots, 'c:/work/b')).toBe(true)
    expect(isInsideAnyFolder(roots, 'C:\\work\\bb\\x.ts')).toBe(false)
    expect(isInsideAnyFolder(roots, '/home/u/c/d')).toBe(true)
    expect(isInsideAnyFolder(roots, '/home/u/other')).toBe(false)
  })
})

describe('the main folder’s own mark', () => {
  it('is derived from the access on a session saved before it existed', () => {
    expect(mainFolderReadOnlyOf({ access: 'review-only' })).toBe(true)
    expect(mainFolderReadOnlyOf({})).toBe(true)
    expect(mainFolderReadOnlyOf({ access: 'edit-folder' })).toBe(false)
    expect(mainFolderReadOnlyOf({ access: 'managed-worktree' })).toBe(false)
  })

  it('is independent of the access once set, except in a worktree', () => {
    expect(
      mainFolderReadOnlyOf({ access: 'edit-folder', mainFolderReadOnly: true })
    ).toBe(true)
    expect(
      mainFolderReadOnlyOf({
        access: 'managed-worktree',
        mainFolderReadOnly: true,
      })
    ).toBe(false)
  })

  it('turns an editable prompt access read-only, and nothing else', () => {
    const marked = { access: 'edit-folder', mainFolderReadOnly: true }
    expect(withMainFolderMark('editable', marked)).toBe('read-only')
    expect(withMainFolderMark('editable', { access: 'edit-folder' })).toBe(
      'editable'
    )
    expect(withMainFolderMark('worktree', marked)).toBe('worktree')
    expect(withMainFolderMark('editable', null)).toBe('editable')
  })
})

describe('the prompt with extra folders', () => {
  const base = {
    workspacePath: '/data/sessions/s1',
    readOnlyFolder: '/repo/a',
    planMode: false,
    webSearch: false,
    bashAvailable: true,
    subagentNames: [],
  }

  it('lists every extra folder, read-only without a grant', () => {
    const prompt = buildCoworkSystemPrompt({
      ...base,
      extraFolders: ['/repo/b', '/repo/c'],
    })
    expect(prompt).toContain('The user also attached these folders')
    expect(prompt).toContain('- `/repo/b`')
    expect(prompt).toContain('- `/repo/c` (READ-ONLY)')
    expect(prompt).not.toContain('attached directly')
  })

  it('says they are writable when the grant covers them', () => {
    const prompt = buildCoworkSystemPrompt({
      ...base,
      folderAccess: 'worktree',
      extraFolders: ['/repo/b'],
      writableExtraFolders: ['/repo/b'],
    })
    expect(prompt).toContain('- `/repo/b` (editable)')
    expect(prompt).toContain('attached directly (never through a worktree)')
    expect(prompt).not.toContain('READ-ONLY ones')
  })

  it('names which folders are editable when only some are', () => {
    const prompt = buildCoworkSystemPrompt({
      ...base,
      extraFolders: ['/repo/b', '/repo/c'],
      writableExtraFolders: ['/repo/c'],
    })
    expect(prompt).toContain('- `/repo/b` (READ-ONLY)')
    expect(prompt).toContain('- `/repo/c` (editable)')
    expect(prompt).toContain('READ-ONLY ones')
  })

  it('says the main folder is read-only while an extra is editable', () => {
    const prompt = buildCoworkSystemPrompt({
      ...base,
      folderAccess: 'read-only',
      extraFolders: ['/repo/b'],
      writableExtraFolders: ['/repo/b'],
    })
    expect(prompt).toContain('project folder: `/repo/a` (READ-ONLY)')
    expect(prompt).toContain('Edit some folders')
    expect(prompt).not.toContain('Review only (writes go')
    expect(prompt).toContain('- `/repo/b` (editable)')
  })

  it('marks the main folder editable when it is', () => {
    const prompt = buildCoworkSystemPrompt({
      ...base,
      folderAccess: 'editable',
      extraFolders: ['/repo/b'],
    })
    expect(prompt).toContain('project folder: `/repo/a` (editable)')
    expect(prompt).toContain('- `/repo/b` (READ-ONLY)')
  })

  it('says nothing about extra folders when there are none', () => {
    expect(buildCoworkSystemPrompt(base)).not.toContain('also attached')
  })
})
