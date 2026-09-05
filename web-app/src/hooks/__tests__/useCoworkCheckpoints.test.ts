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
  useCoworkCheckpoints.setState({ bySession: {} })
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
