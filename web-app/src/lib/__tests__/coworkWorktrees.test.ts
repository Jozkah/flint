import { describe, expect, it } from 'vitest'
import { classify, orphans, describePending } from '@/lib/coworkWorktrees'
import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'

const record = (path: string): WorktreeRecord => ({
  path,
  branch: `jan/cowork/${path}`,
  baseSha: 'a'.repeat(40),
  sourceRoot: '/repo',
  identity: { root: '/repo', firstCommit: 'b'.repeat(40) },
  uncommittedAtCreation: [],
})

describe('the worktrees a crash left behind', () => {
  it('separates this session’s from the ones nobody holds', () => {
    const mine = record('/data/worktrees/mine')
    const found = [record('/data/worktrees/other'), mine]

    expect(classify(found, mine).map((one) => one.mine)).toEqual([true, false])
    expect(orphans(found, mine).map((one) => one.path)).toEqual([
      '/data/worktrees/other',
    ])
  })

  it('treats every worktree as an orphan when this session holds none', () => {
    const found = [record('/b'), record('/a')]
    // Sorted, so the same disk produces the same list every time.
    expect(orphans(found, null).map((one) => one.path)).toEqual(['/a', '/b'])
  })

  it('says what would be lost, rather than asking whether to lose it', () => {
    expect(describePending([])).toBe('')
    expect(describePending(['a.ts', 'b.ts'])).toBe('a.ts, b.ts')
    const many = describePending(['1', '2', '3', '4', '5', '6', '7'])
    expect(many).toContain('and 2 more')
  })
})
