import { describe, expect, it } from 'vitest'
import {
  extraFoldersOf,
  isInsideAnyFolder,
  sameFolder,
  withExtraFolder,
  withoutExtraFolder,
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

  it('contain paths under them, not siblings sharing a prefix', () => {
    const roots = ['C:\\work\\b', '/home/u/c']
    expect(isInsideAnyFolder(roots, 'C:\\work\\b\\src\\x.ts')).toBe(true)
    expect(isInsideAnyFolder(roots, 'c:/work/b')).toBe(true)
    expect(isInsideAnyFolder(roots, 'C:\\work\\bb\\x.ts')).toBe(false)
    expect(isInsideAnyFolder(roots, '/home/u/c/d')).toBe(true)
    expect(isInsideAnyFolder(roots, '/home/u/other')).toBe(false)
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
    expect(prompt).toContain('- `/repo/c`')
    expect(prompt).toContain('They are READ-ONLY')
  })

  it('says they are writable when the grant covers them', () => {
    const prompt = buildCoworkSystemPrompt({
      ...base,
      folderAccess: 'worktree',
      extraFolders: ['/repo/b'],
      extraFoldersWritable: true,
    })
    expect(prompt).toContain('attached directly (never through a worktree)')
    expect(prompt).not.toContain('They are READ-ONLY')
  })

  it('says nothing about extra folders when there are none', () => {
    expect(buildCoworkSystemPrompt(base)).not.toContain('also attached')
  })
})
