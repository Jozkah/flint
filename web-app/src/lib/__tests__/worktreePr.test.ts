import { describe, expect, it } from 'vitest'
import { parseWorktreePr } from '../worktreePr'

describe('parseWorktreePr', () => {
  it('reads numbers, #numbers and github URLs', () => {
    expect(parseWorktreePr(123)).toEqual({ ok: true, number: 123, base: 'pr:123' })
    expect(parseWorktreePr(' #45 ')).toEqual({ ok: true, number: 45, base: 'pr:45' })
    expect(parseWorktreePr('https://github.com/Jozkah/flint/pull/7/commits')).toEqual({
      ok: true,
      number: 7,
      base: 'pr:Jozkah/flint#7',
    })
  })
  it('refuses anything else', () => {
    for (const bad of ['', 'abc', '0', '-1', 1.5, null, 'https://example.com/a/b/pull/1', 'http://github.com/a/b/pull/1', '12 --upload-pack=x'])
      expect(parseWorktreePr(bad).ok).toBe(false)
  })
})
