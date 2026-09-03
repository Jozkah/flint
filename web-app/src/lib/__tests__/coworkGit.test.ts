import { describe, it, expect } from 'vitest'
import { repoName, statusBadge, type GitStatus } from '@/lib/coworkGit'

describe('coworkGit helpers', () => {
  it('derives the repository name from the root path', () => {
    const status: GitStatus = {
      branch: 'main',
      repoRoot: '/home/user/projects/jan',
      files: [],
      additions: 0,
      deletions: 0,
    }
    expect(repoName(status)).toBe('jan')
  })

  it('returns null when there is no status', () => {
    expect(repoName(null)).toBeNull()
  })

  it('maps each status to a single-letter badge', () => {
    expect(statusBadge('modified')).toBe('M')
    expect(statusBadge('added')).toBe('A')
    expect(statusBadge('deleted')).toBe('D')
    expect(statusBadge('renamed')).toBe('R')
    expect(statusBadge('copied')).toBe('C')
    expect(statusBadge('type_changed')).toBe('T')
    expect(statusBadge('untracked')).toBe('U')
    expect(statusBadge('unmerged')).toBe('!')
  })
})
