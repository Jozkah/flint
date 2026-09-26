import { describe, expect, it } from 'vitest'
import { claimKey, prRelation, type PrStatus } from '@/stores/pr-status-store'

const pr: PrStatus = {
  number: 7,
  title: 'Outside change',
  url: 'https://github.com/o/r/pull/7',
  state: 'open',
  head: 'feat/outside',
  base: 'main',
  additions: 1,
  deletions: 0,
  checks: { passed: 0, failed: 0, pending: 0 },
}
const folder = 'C:\\repo'

describe('prRelation: a pull request opened outside Flint', () => {
  it('belongs to the session whose own worktree is its head', () => {
    expect(prRelation(pr, 'C:\\wt\\s1', {}, 's1', { path: 'C:/wt/s1/', branch: 'x' })).toBe('mine')
    expect(prRelation(pr, folder, {}, 's1', { path: 'C:\\wt\\s1', branch: 'feat/outside' })).toBe('mine')
  })

  it('is only named, muted, for sessions sharing the checkout', () => {
    expect(prRelation(pr, folder, {}, 's2')).toBe('foreign')
    expect(prRelation(pr, folder, {}, 's3', { path: 'C:\\wt\\s3', branch: 'other' })).toBe('foreign')
  })

  it('keeps claims as before', () => {
    const claims = { [claimKey(folder, 7)]: 's1' }
    expect(prRelation(pr, folder, claims, 's1')).toBe('mine')
    expect(prRelation(pr, folder, claims, 's2')).toBe('hidden')
  })

  it('is shown plainly where there are no sessions to tell apart', () => {
    expect(prRelation(pr, folder, {}, undefined)).toBe('mine')
  })
})
