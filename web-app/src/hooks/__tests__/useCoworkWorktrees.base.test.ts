import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/hooks/useServiceHub', () => ({ getServiceHub: () => ({}) }))

import { useCoworkWorktrees } from '../useCoworkWorktrees'
import { useCoworkParallel } from '../useCoworkParallel'

const record = { path: '/wt', branch: 'flint/x', baseSha: 'a', sourceRoot: '/p', identity: { root: '/p', firstCommit: null }, uncommittedAtCreation: [] }

describe('worktree base setting', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(record)
    useCoworkParallel.setState({ worktreeBase: 'fresh' })
  })

  it('fresh (default) sends no base', async () => {
    await useCoworkWorktrees.getState().ensure('s', '/p', '/d')
    expect(invoke.mock.calls[0][1].base).toBeNull()
  })

  it('head sends HEAD, and an explicit base still wins', async () => {
    useCoworkParallel.setState({ worktreeBase: 'head' })
    await useCoworkWorktrees.getState().ensure('s', '/p', '/d')
    expect(invoke.mock.calls[0][1].base).toBe('HEAD')
    await useCoworkWorktrees.getState().ensure('s', '/p', '/d', { base: 'develop' })
    expect(invoke.mock.calls[1][1].base).toBe('develop')
  })
})
