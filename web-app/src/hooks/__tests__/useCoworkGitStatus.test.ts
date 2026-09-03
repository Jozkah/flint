import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const loadGitStatus = vi.fn()

vi.mock('@/lib/coworkGit', () => ({
  loadGitStatus: (...args: unknown[]) => loadGitStatus(...args),
}))

import { useCoworkGitStatus } from '../useCoworkGitStatus'
import type { GitStatus } from '@/lib/coworkGit'

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: 'main',
  repoRoot: '/repo',
  files: [],
  additions: 0,
  deletions: 0,
  ...over,
})

describe('useCoworkGitStatus', () => {
  beforeEach(() => {
    loadGitStatus.mockReset()
  })

  it('stays empty and never calls the backend without a folder', async () => {
    const { result } = renderHook(() => useCoworkGitStatus(null))
    await waitFor(() => expect(result.current.nonce).toBeGreaterThan(0))
    expect(result.current.status).toBeNull()
    expect(loadGitStatus).not.toHaveBeenCalled()
  })

  it('loads status for an attached folder', async () => {
    loadGitStatus.mockResolvedValue(status({ additions: 4 }))
    const { result } = renderHook(() => useCoworkGitStatus('/repo'))
    await waitFor(() => expect(result.current.status?.additions).toBe(4))
    expect(loadGitStatus).toHaveBeenCalledWith('/repo', 'working')
  })

  it('refetches with the new scope when it changes', async () => {
    loadGitStatus.mockResolvedValue(status())
    const { result } = renderHook(() => useCoworkGitStatus('/repo'))
    await waitFor(() => expect(loadGitStatus).toHaveBeenCalledTimes(1))
    act(() => result.current.setScope('staged'))
    await waitFor(() =>
      expect(loadGitStatus).toHaveBeenLastCalledWith('/repo', 'staged')
    )
  })

  it('surfaces a load failure as an error and clears the status', async () => {
    loadGitStatus.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useCoworkGitStatus('/repo'))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.status).toBeNull()
  })
})
