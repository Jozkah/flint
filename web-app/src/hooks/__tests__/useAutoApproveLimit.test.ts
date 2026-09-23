import { describe, expect, it, beforeEach } from 'vitest'
import {
  DEFAULT_AUTO_APPROVE_LIMIT,
  MAX_AUTO_APPROVE_LIMIT,
  noteAutoApproved,
  normalizeAutoApproveLimit,
  resetAutoApproveStreak,
  useAutoApproveLimit,
} from '../useAutoApproveLimit'

describe('useAutoApproveLimit', () => {
  beforeEach(() => {
    useAutoApproveLimit.getState().setLimit(DEFAULT_AUTO_APPROVE_LIMIT)
    resetAutoApproveStreak('s1')
  })

  it('keeps the limit a whole number between 0 and the maximum', () => {
    expect(normalizeAutoApproveLimit(12.7)).toBe(12)
    expect(normalizeAutoApproveLimit('25')).toBe(25)
    expect(normalizeAutoApproveLimit(0)).toBe(0)
    expect(normalizeAutoApproveLimit(-3)).toBe(0)
    expect(normalizeAutoApproveLimit(1e9)).toBe(MAX_AUTO_APPROVE_LIMIT)
    // Unreadable input keeps the pause on rather than turning it off.
    expect(normalizeAutoApproveLimit('')).toBe(DEFAULT_AUTO_APPROVE_LIMIT)
    expect(normalizeAutoApproveLimit('abc')).toBe(DEFAULT_AUTO_APPROVE_LIMIT)
    expect(normalizeAutoApproveLimit(NaN)).toBe(DEFAULT_AUTO_APPROVE_LIMIT)
    expect(normalizeAutoApproveLimit(undefined)).toBe(
      DEFAULT_AUTO_APPROVE_LIMIT
    )
  })

  it('stores the normalized value', () => {
    useAutoApproveLimit.getState().setLimit('5000')
    expect(useAutoApproveLimit.getState().limit).toBe(MAX_AUTO_APPROVE_LIMIT)
    useAutoApproveLimit.getState().setLimit(3)
    expect(useAutoApproveLimit.getState().limit).toBe(3)
  })

  it('persists the limit under its own key', () => {
    useAutoApproveLimit.getState().setLimit(7)
    const stored = JSON.parse(
      localStorage.getItem('auto-approve-limit') ?? '{}'
    )
    expect(stored.state.limit).toBe(7)
  })

  it('pauses after the limit and starts over once the user is asked', () => {
    const over = [1, 2, 3].map(() => noteAutoApproved('s1', 2))
    expect(over).toEqual([false, false, true])
    resetAutoApproveStreak('s1')
    expect(noteAutoApproved('s1', 2)).toBe(false)
    // 0 turns the pause off.
    for (let i = 0; i < 100; i++) expect(noteAutoApproved('s2', 0)).toBe(false)
  })
})
