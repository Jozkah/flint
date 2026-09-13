import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { useCoworkCheckpoints } from '../useCoworkCheckpoints'

const store = () => useCoworkCheckpoints.getState()
const SESSION = 'session-a'
const TREE = '/data/worktrees/s1'

const captured = (sha: string) => ({
  sha,
  label: 'a turn',
  destination: 'managed' as const,
  root: TREE,
})

beforeEach(() => {
  vi.clearAllMocks()
  useCoworkCheckpoints.setState({ bySession: {}, head: {} })
})

// Mock-backed: `invoke` is a stub, so these pin down the store's transitions
// and the commands it sends, not what Git does with them.
describe('a restore that can be undone', () => {
  const chain = () => [
    { ...captured('sha1'), at: 1, access: 'managed-worktree' },
    { ...captured('sha2'), at: 2, access: 'managed-worktree' },
  ]

  it('adds a safety point to the chain before restoring', async () => {
    useCoworkCheckpoints.setState({
      bySession: { [SESSION]: chain() },
      head: { [SESSION]: 'sha2' },
    })
    invoke.mockResolvedValueOnce({ ...captured('safe'), label: 'Before restore' })

    const safety = await store().captureSafety({
      sessionId: SESSION,
      root: TREE,
      label: 'Before restore',
      access: 'managed-worktree',
    })

    expect(safety).toMatchObject({ ok: true, entry: { sha: 'safe', safety: true } })
    // Chained onto the newest point, and recorded as a whole-tree capture in a
    // tree Jan owns.
    expect(invoke).toHaveBeenCalledWith(
      'agent_checkpoint_capture',
      expect.objectContaining({ parent: 'sha2', destination: 'managed' })
    )
    expect(store().bySession[SESSION].map((one) => one.sha)).toEqual([
      'sha1',
      'sha2',
      'safe',
    ])

    invoke.mockResolvedValueOnce(undefined)
    expect(await store().restore(SESSION, 'sha1')).toEqual({ ok: true })

    // Restored against the safety point, so files added since the target are
    // removed and every one of them is still held by that point.
    expect(invoke).toHaveBeenLastCalledWith(
      'agent_checkpoint_restore',
      expect.objectContaining({
        checkpoint: expect.objectContaining({ sha: 'sha1' }),
        latest: 'safe',
      })
    )
    // The way back from the restore survives it; the point it skipped over
    // does not.
    expect(store().bySession[SESSION].map((one) => one.sha)).toEqual([
      'sha1',
      'safe',
    ])
    expect(store().head[SESSION]).toBe('sha1')
  })

  it('returns the reason, and changes nothing, when the safety point fails', async () => {
    useCoworkCheckpoints.setState({ bySession: { [SESSION]: chain() } })
    invoke.mockRejectedValueOnce(new Error('index.lock exists'))

    const safety = await store().captureSafety({
      sessionId: SESSION,
      root: TREE,
      label: 'Before restore',
      access: 'managed-worktree',
    })

    expect(safety).toEqual({ ok: false, reason: 'index.lock exists' })
    expect(store().bySession[SESSION]).toHaveLength(2)
  })

  it('compares newer edits with the state the tree was last put in', async () => {
    useCoworkCheckpoints.setState({
      bySession: {
        [SESSION]: [
          ...chain(),
          { ...captured('safe'), at: 3, access: 'managed-worktree', safety: true },
        ],
      },
      // Restored to sha1: the safety point holds what the restore replaced,
      // which is not an edit someone made afterwards.
      head: { [SESSION]: 'sha1' },
    })
    invoke.mockResolvedValueOnce({ kind: 'restore', sha: 'sha2', files: [], changedSinceLatest: [] })

    await store().plan(SESSION, 'sha2')

    expect(invoke).toHaveBeenCalledWith(
      'agent_checkpoint_plan',
      expect.objectContaining({ latest: 'sha1' })
    )
  })

  it('falls back to the newest point when the head is not in the chain', async () => {
    useCoworkCheckpoints.setState({
      bySession: { [SESSION]: chain() },
      head: { [SESSION]: 'gone' },
    })
    invoke.mockResolvedValueOnce({ kind: 'restore', sha: 'sha1' })

    await store().plan(SESSION, 'sha1')

    expect(invoke).toHaveBeenCalledWith(
      'agent_checkpoint_plan',
      expect.objectContaining({ latest: 'sha2' })
    )
  })
})

describe('the points a session can go back to', () => {
  it('chains each point to the previous one in the same tree', async () => {
    invoke.mockResolvedValueOnce(captured('sha1'))
    await store().capture({
      sessionId: SESSION,
      root: TREE,
      label: 'first',
      changed: [],
      destination: 'managed',
      access: 'managed-worktree',
    })
    invoke.mockResolvedValueOnce(captured('sha2'))
    await store().capture({
      sessionId: SESSION,
      root: TREE,
      label: 'second',
      changed: [],
      destination: 'managed',
      access: 'managed-worktree',
    })

    // Chained, so the history reads as one line of work rather than a set of
    // unrelated snapshots.
    expect(invoke.mock.calls[1][1]).toMatchObject({ parent: 'sha1' })
    expect(store().bySession[SESSION].map((one) => one.sha)).toEqual([
      'sha1',
      'sha2',
    ])
  })

  it('does not fail a run because a checkpoint could not be taken', async () => {
    invoke.mockRejectedValueOnce(new Error('not a repository'))

    await expect(
      store().capture({
        sessionId: SESSION,
        root: TREE,
        label: 'first',
        changed: [],
        destination: 'managed',
        access: 'managed-worktree',
      })
    ).resolves.toBeNull()
    // Which shows up as there being nowhere to go back to, not as a failure.
    expect(store().usable(SESSION, TREE)).toEqual([])
  })

  it('offers only points that resolve in the tree being worked in', async () => {
    useCoworkCheckpoints.setState({
      bySession: {
        [SESSION]: [
          { ...captured('sha1'), at: 1, access: 'managed-worktree' },
          {
            ...captured('sha2'),
            root: '/somewhere/else',
            at: 2,
            access: 'edit-folder',
          },
        ],
      },
    })

    // A session that moved must not be offered a rewind that would resolve
    // against a different tree.
    expect(
      store()
        .usable(SESSION, TREE)
        .map((one) => one.sha)
    ).toEqual(['sha1'])
    expect(store().usable(SESSION, null)).toEqual([])
  })

  it('drops the points a restore made unreachable', async () => {
    useCoworkCheckpoints.setState({
      bySession: {
        [SESSION]: [
          { ...captured('sha1'), at: 1, access: 'managed-worktree' },
          { ...captured('sha2'), at: 2, access: 'managed-worktree' },
          { ...captured('sha3'), at: 3, access: 'managed-worktree' },
        ],
      },
    })
    invoke.mockResolvedValueOnce(undefined)

    expect(await store().restore(SESSION, 'sha2')).toEqual({ ok: true })
    // Everything after the restored point describes a tree that is gone;
    // keeping it would offer a way "forward" resolving against nothing.
    expect(store().bySession[SESSION].map((one) => one.sha)).toEqual([
      'sha1',
      'sha2',
    ])
  })

  it('keeps the chain when a restore is refused', async () => {
    useCoworkCheckpoints.setState({
      bySession: {
        [SESSION]: [
          { ...captured('sha1'), at: 1, access: 'edit-folder' },
          { ...captured('sha2'), at: 2, access: 'edit-folder' },
        ],
      },
    })
    invoke.mockRejectedValueOnce(
      new Error('this checkpoint is in your own checkout')
    )

    const done = await store().restore(SESSION, 'sha1')

    expect(done).toEqual({
      ok: false,
      reason: 'this checkpoint is in your own checkout',
    })
    expect(store().bySession[SESSION]).toHaveLength(2)
  })

  it('refuses to plan or restore a point it never recorded', async () => {
    expect(await store().plan(SESSION, 'nope')).toMatchObject({ ok: false })
    expect(await store().restore(SESSION, 'nope')).toMatchObject({ ok: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('forgets a session’s chain in every tree it used', async () => {
    useCoworkCheckpoints.setState({
      bySession: {
        [SESSION]: [
          { ...captured('sha1'), at: 1, access: 'managed-worktree' },
          { ...captured('sha2'), root: '/other', at: 2, access: 'edit-folder' },
        ],
      },
    })
    invoke.mockResolvedValue(undefined)

    await store().forget(SESSION)

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(store().bySession[SESSION]).toBeUndefined()
  })
})
