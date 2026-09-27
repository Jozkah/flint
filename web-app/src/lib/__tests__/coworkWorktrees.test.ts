import { describe, expect, it } from 'vitest'
import {
  classify,
  orphans,
  describePending,
  dismissNotCarried,
  hideRecovery,
  notCarriedDismissed,
  recoverableWorktrees,
  recoveryHidden,
  sessionShortId,
  sessionWorktreeBranch,
  shortPath,
  worktreeOwner,
} from '@/lib/coworkWorktrees'
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

describe('which left-over worktrees a session is offered', () => {
  const at = (id: string) => ({
    ...record(`/data/worktrees/abcd1234/${sessionShortId(id)}`),
    branch: `flint/fix-${sessionShortId(id)}`,
  })

  it('never offers another live session’s worktree', () => {
    const found = [at('live-b'), at('gone-c'), at('me-a')]
    const shown = recoverableWorktrees(found, null, 'me-a', ['me-a', 'live-b'])
    expect(shown.map((one) => one.path).sort()).toEqual(
      [at('gone-c').path, at('me-a').path].sort()
    )
  })

  it('recognises a session by its legacy branch too', () => {
    const legacy = {
      ...record('/x/legacy'),
      branch: sessionWorktreeBranch('live-b'),
    }
    expect(worktreeOwner(legacy, ['live-b'])).toBe('live-b')
    expect(
      recoverableWorktrees([legacy], null, 'me', ['me', 'live-b'])
    ).toEqual([])
  })

  it('skips a path another session holds in memory', () => {
    const held = record('/x/held')
    expect(
      recoverableWorktrees([held], null, 'me', ['me'], ['/x/held'])
    ).toEqual([])
  })

  it('shortens a long path to its last two segments', () => {
    expect(shortPath('C:\\Users\\me\\data\\worktrees\\ab\\cd')).toBe('…/ab/cd')
    expect(shortPath('/a/b')).toBe('/a/b')
  })

  it('remembers hidden folders and dismissed notes', () => {
    localStorage.clear()
    expect(recoveryHidden('/repo')).toBe(false)
    hideRecovery('/repo')
    expect(recoveryHidden('/repo')).toBe(true)
    expect(notCarriedDismissed('s1')).toBe(false)
    dismissNotCarried('s1')
    expect(notCarriedDismissed('s1')).toBe(true)
    expect(notCarriedDismissed('s2')).toBe(false)
  })
})
