/** Only what this session changed gets reported as this session's change. */
import { describe, expect, it } from 'vitest'
import {
  formatChangeSummary,
  janAuthoredChanges,
  pathsMatch,
} from '../coworkChangeSummary'
import type { CoworkFileDiff } from '../coworkDiffs'
import type { GitStatus } from '../coworkGit'

const diff = (
  path: string,
  additions = 2,
  deletions = 1
): CoworkFileDiff => ({ path, additions, deletions, operations: [] })

const git = (
  files: { path: string; additions: number; deletions: number }[]
): GitStatus => ({
  branch: 'main',
  repoRoot: '/repo',
  files: files.map((f) => ({
    ...f,
    origPath: null,
    status: 'modified' as never,
    staged: false,
    unstaged: true,
    binary: false,
  })),
  additions: files.reduce((s, f) => s + f.additions, 0),
  deletions: files.reduce((s, f) => s + f.deletions, 0),
})

it("does not report the user's own uncommitted work as Jan's", () => {
  const counts = janAuthoredChanges(
    [diff('src/app.ts')],
    git([
      { path: 'src/app.ts', additions: 2, deletions: 1 },
      { path: 'notes/todo.md', additions: 40, deletions: 3 },
    ])
  )
  expect(counts).toEqual({ fileCount: 1, additions: 2, deletions: 1 })
})

it('reports nothing when the session wrote nothing, however dirty the tree', () => {
  expect(
    janAuthoredChanges([], git([{ path: 'a.ts', additions: 9, deletions: 9 }]))
  ).toEqual({ fileCount: 0, additions: 0, deletions: 0 })
})

it('takes line counts from Git for a direct edit that reported none', () => {
  const counts = janAuthoredChanges(
    [diff('src/app.ts', 0, 0)],
    git([{ path: 'src/app.ts', additions: 7, deletions: 2 }])
  )
  expect(counts).toEqual({ fileCount: 1, additions: 7, deletions: 2 })
})

it('counts a file once when the sandbox and Git both see it', () => {
  const counts = janAuthoredChanges(
    [diff('/work/repo/src/app.ts', 3, 1)],
    git([{ path: 'src/app.ts', additions: 3, deletions: 1 }])
  )
  expect(counts.fileCount).toBe(1)
  expect(counts.additions).toBe(3)
})

it('does not treat a same-named file in another directory as the same file', () => {
  expect(pathsMatch('src/app.ts', 'vendor/src/app.ts')).toBe(true)
  expect(pathsMatch('src/app.ts', 'other/app.ts')).toBe(false)
  expect(pathsMatch('./src/app.ts', 'src/app.ts')).toBe(true)
})

it('reads as one line', () => {
  expect(formatChangeSummary({ fileCount: 3, additions: 24, deletions: 8 })).toBe(
    '3 files changed · +24 −8'
  )
  expect(formatChangeSummary({ fileCount: 1, additions: 2, deletions: 0 })).toBe(
    '1 file changed · +2 −0'
  )
})
