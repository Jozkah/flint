import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { resumeSessionWorktree } from '../worktreeResume'

const resume = vi.fn()
const forget = vi.fn()
const revokeSession = vi.fn()

vi.mock('@/hooks/useCoworkWorktrees', () => ({
  useCoworkWorktrees: { getState: () => ({ resume, forget }) },
}))
vi.mock('@/hooks/useDirectEditGrants', () => ({
  useDirectEditGrants: { getState: () => ({ revokeSession }) },
}))

const record = { path: '/wt/a', branch: 'flint/x' }

describe('resumeSessionWorktree', () => {
  beforeEach(() => {
    resume.mockReset()
    forget.mockReset()
    revokeSession.mockReset().mockResolvedValue(true)
    useCoworkSessions.setState({
      sessions: [{ id: 's1', title: 'S', folder: '/p', turns: [], messages: [], updated: 1, createdAt: 1, access: 'managed-worktree' }] as never,
    })
  })
  const access = () => useCoworkSessions.getState().sessions[0].access

  it('keeps the session in its worktree when the checkout is found', async () => {
    resume.mockResolvedValue({ ok: true, record })
    expect(await resumeSessionWorktree('s1', '/p', '/d')).toEqual({ ok: true, record })
    expect(resume).toHaveBeenCalledWith('s1', '/p', '/d')
    expect(forget).not.toHaveBeenCalled()
    expect(access()).toBe('managed-worktree')
  })

  it('clears the binding, withdraws the grant and returns to review-only when it is gone', async () => {
    resume.mockResolvedValue({ ok: false, reason: 'the worktree no longer exists' })
    const out = await resumeSessionWorktree('s1', '/p', '/d')
    expect(out).toEqual({ ok: false, reason: 'the worktree no longer exists' })
    expect(forget).toHaveBeenCalledWith('s1')
    expect(revokeSession).toHaveBeenCalledWith('s1')
    expect(access()).toBe('review-only')
  })

  it('does the same for a directory that is not a separate worktree', async () => {
    resume.mockResolvedValue({ ok: false, reason: '/wt/a is the project checkout itself, not a separate worktree' })
    expect((await resumeSessionWorktree('s1', '/p', '/d')).ok).toBe(false)
    expect(access()).toBe('review-only')
  })
})
