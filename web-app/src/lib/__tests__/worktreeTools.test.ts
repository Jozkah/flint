import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { runEnterWorktree, runExitWorktree } from '../worktreeTools'

const ensure = vi.fn()
const discard = vi.fn()
const list = vi.fn()
const pending = vi.fn()
const unmerged = vi.fn()
const adopt = vi.fn()
const forget = vi.fn()
const authorize = vi.fn()
const revokeSession = vi.fn()
const bySession: Record<string, unknown> = {}

vi.mock('@/hooks/useCoworkWorktrees', () => ({
  useCoworkWorktrees: {
    getState: () => ({
      bySession,
      ensure,
      discard,
      list,
      pending,
      unmerged,
      adopt,
      forget,
    }),
  },
}))
vi.mock('@/hooks/useDirectEditGrants', () => ({
  useDirectEditGrants: { getState: () => ({ authorize, revokeSession }) },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => '/data' }) }),
}))

const record = {
  path: '/wt/a',
  branch: 'flint/side',
  baseSha: 'abc',
  baseBranch: 'main',
  sourceRoot: '/proj',
  identity: { root: '/proj', firstCommit: null },
  uncommittedAtCreation: [],
}

const seed = (extra: Record<string, unknown> = {}) =>
  useCoworkSessions.setState({
    currentId: 's1',
    sessions: [
      {
        id: 's1',
        title: 'S',
        folder: '/proj',
        turns: [],
        messages: [],
        updated: 1,
        createdAt: 1,
        access: 'review-only',
        ...extra,
      },
    ] as never,
  })
const accessOf = () =>
  useCoworkSessions.getState().sessions.find((s) => s.id === 's1')?.access

describe('enter_worktree', () => {
  const approve = vi.fn()
  beforeEach(() => {
    seed()
    for (const k of Object.keys(bySession)) delete bySession[k]
    for (const f of [ensure, discard, list, pending, unmerged, adopt, forget, authorize, revokeSession, approve])
      f.mockReset()
    ensure.mockResolvedValue({ ok: true, record })
    list.mockResolvedValue([])
    discard.mockResolvedValue({ ok: true })
    authorize.mockResolvedValue({ ok: true })
    approve.mockResolvedValue(true)
  })

  it('creates a worktree, asks naming folder, branch and base, then grants and switches access', async () => {
    const out = await runEnterWorktree('s1', { name: 'side', base: 'main' }, { mode: 'ask', onApprove: approve })
    expect(out.isError).toBeFalsy()
    expect(ensure).toHaveBeenCalledWith('s1', '/proj', '/data', { title: 'side', base: 'main' })
    expect(approve).toHaveBeenCalledWith(
      expect.any(String),
      'enter_worktree',
      { folder: '/wt/a', branch: 'flint/side', base: 'main', project: '/proj' },
      undefined,
      undefined
    )
    expect(authorize).toHaveBeenCalledWith('s1', '/wt/a', '/data', [])
    expect(accessOf()).toBe('managed-worktree')
  })

  it('asks even in bypass mode', async () => {
    await runEnterWorktree('s1', {}, { mode: 'bypass', onApprove: approve })
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it('removes what it made and changes nothing when the user says no', async () => {
    approve.mockResolvedValue(false)
    const out = await runEnterWorktree('s1', {}, { mode: 'ask', onApprove: approve })
    expect(out.isError).toBe(true)
    expect(out.output).toContain('did not allow')
    expect(discard).toHaveBeenCalledWith('s1', '/data', true)
    expect(authorize).not.toHaveBeenCalled()
    expect(accessOf()).toBe('review-only')
  })

  it('switches to an existing worktree of that name without making one, and keeps it on a no', async () => {
    list.mockResolvedValue([record])
    approve.mockResolvedValue(false)
    await runEnterWorktree('s1', { name: 'side' }, { mode: 'ask', onApprove: approve })
    expect(adopt).toHaveBeenCalledWith('s1', record)
    expect(ensure).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
    expect(forget).toHaveBeenCalledWith('s1')
  })

  it('refuses in review mode, without a folder, without a prompt, and when already inside', async () => {
    expect((await runEnterWorktree('s1', {}, { mode: 'review', onApprove: approve })).isError).toBe(true)
    expect((await runEnterWorktree('s1', {}, { mode: 'ask' })).output).toContain('approval')
    seed({ folder: null })
    expect((await runEnterWorktree('s1', {}, { mode: 'ask', onApprove: approve })).output).toContain('folder')
    seed({ access: 'managed-worktree' })
    bySession.s1 = record
    expect((await runEnterWorktree('s1', {}, { mode: 'ask', onApprove: approve })).output).toContain('exit_worktree')
    expect(approve).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('rejects a base that looks like an option', async () => {
    const out = await runEnterWorktree('s1', { base: '--upload-pack=x' }, { mode: 'ask', onApprove: approve })
    expect(out.isError).toBe(true)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('drops the worktree when the grant fails', async () => {
    authorize.mockResolvedValue({ ok: false, reason: 'nope' })
    const out = await runEnterWorktree('s1', {}, { mode: 'ask', onApprove: approve })
    expect(out.isError).toBe(true)
    expect(discard).toHaveBeenCalled()
    expect(accessOf()).toBe('review-only')
  })
})

describe('exit_worktree', () => {
  beforeEach(() => {
    seed({ access: 'managed-worktree' })
    for (const k of Object.keys(bySession)) delete bySession[k]
    bySession.s1 = record
    for (const f of [discard, pending, unmerged, forget, revokeSession]) f.mockReset()
    pending.mockResolvedValue([])
    unmerged.mockResolvedValue([])
    discard.mockResolvedValue({ ok: true })
  })

  it('requires keep', async () => {
    expect((await runExitWorktree('s1', {})).isError).toBe(true)
  })

  it('removes a clean worktree and returns the session to review-only', async () => {
    const out = await runExitWorktree('s1', { keep: false })
    expect(out.isError).toBeFalsy()
    expect(discard).toHaveBeenCalledWith('s1', '/data', false)
    expect(revokeSession).toHaveBeenCalledWith('s1')
    expect(accessOf()).toBe('review-only')
  })

  it('refuses to remove one with uncommitted or unmerged work and stays inside', async () => {
    pending.mockResolvedValue(['a.ts'])
    const dirty = await runExitWorktree('s1', { keep: false })
    expect(dirty.isError).toBe(true)
    expect(dirty.output).toContain('keep: true')
    pending.mockResolvedValue([])
    unmerged.mockResolvedValue(['abc fix'])
    expect((await runExitWorktree('s1', { keep: false })).isError).toBe(true)
    expect(discard).not.toHaveBeenCalled()
    expect(accessOf()).toBe('managed-worktree')
  })

  it('keep: true leaves it on disk regardless of work', async () => {
    pending.mockResolvedValue(['a.ts'])
    const out = await runExitWorktree('s1', { keep: true })
    expect(out.isError).toBeFalsy()
    expect(discard).not.toHaveBeenCalled()
    expect(forget).toHaveBeenCalledWith('s1')
    expect(accessOf()).toBe('review-only')
  })

  it('says so when the session is not in a worktree', async () => {
    delete bySession.s1
    expect((await runExitWorktree('s1', { keep: true })).output).toContain('not in a worktree')
  })
})
