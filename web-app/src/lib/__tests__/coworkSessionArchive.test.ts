import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enabled: true,
  put: vi.fn(async () => 'A'),
}))

vi.mock('@/lib/archive', () => ({
  archiveEnabled: async () => h.enabled,
  archiveApi: { put: h.put },
  trackArchiveWork: <T,>(work: Promise<T>) => work,
}))

import {
  archiveCoworkSession,
  restoreCoworkSession,
} from '@/lib/coworkSessionLifecycle'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'

const session = (id: string) =>
  ({
    id,
    title: `Title ${id}`,
    folder: null,
    turns: [],
    messages: [],
    subagents: [],
    created: 1,
    updated: 1,
  }) as never

const record = { path: '/wt', branch: 'b' } as never

describe('archiving a Cowork session', () => {
  beforeEach(() => {
    h.enabled = true
    h.put.mockClear()
    useCoworkSessions.setState({
      sessions: [session('A'), session('B')],
      currentId: 'A',
    })
    useCoworkRun.setState({ runs: {}, outcomes: {}, liveTurns: {} })
    useCoworkWorktrees.setState({ bySession: { A: record } })
  })

  it('keeps the session and its worktree record, then removes it from the list', async () => {
    expect(await archiveCoworkSession('A', true)).toBe(true)
    expect(h.put).toHaveBeenCalledWith(
      'cowork',
      'A',
      'Title A',
      { session: expect.objectContaining({ id: 'A' }) },
      { worktree: record, discardOnPurge: true }
    )
    expect(useCoworkSessions.getState().sessions.map((s) => s.id)).toEqual(['B'])
    // The worktree record stays: archiving never discards the worktree.
    expect(useCoworkWorktrees.getState().bySession.A).toBe(record)
  })

  it('does not ask for the worktree to be removed when none exists or it was kept', async () => {
    await archiveCoworkSession('B', true)
    expect(h.put.mock.calls[0][4]).toEqual({ worktree: null, discardOnPurge: false })
    h.put.mockClear()
    useCoworkSessions.setState({ sessions: [session('A')], currentId: 'A' })
    await archiveCoworkSession('A', false)
    expect(h.put.mock.calls[0][4]).toEqual({ worktree: record, discardOnPurge: false })
  })

  it('leaves the session alone when the archive fails', async () => {
    h.put.mockRejectedValueOnce(new Error('disk full'))
    await expect(archiveCoworkSession('A', false)).rejects.toThrow('disk full')
    expect(useCoworkSessions.getState().sessions.map((s) => s.id)).toEqual(['A', 'B'])
  })

  it('does nothing when the archive is off, so the caller deletes as before', async () => {
    h.enabled = false
    expect(await archiveCoworkSession('A', false)).toBe(false)
    expect(h.put).not.toHaveBeenCalled()
    expect(useCoworkSessions.getState().sessions).toHaveLength(2)
  })

  it('restores the session and its worktree record', async () => {
    await archiveCoworkSession('A', false)
    useCoworkWorktrees.setState({ bySession: {} })
    const payload = h.put.mock.calls[0][3]
    const extra = h.put.mock.calls[0][4]
    expect(restoreCoworkSession(payload, extra)).toBe(true)
    expect(useCoworkSessions.getState().sessions.map((s) => s.id)).toEqual(['A', 'B'])
    expect(useCoworkSessions.getState().currentId).toBe('A')
    expect(useCoworkWorktrees.getState().bySession.A).toEqual(record)
    // A second restore of the same id is refused rather than duplicated.
    expect(restoreCoworkSession(payload, extra)).toBe(false)
    expect(restoreCoworkSession(null, null)).toBe(false)
  })
})
