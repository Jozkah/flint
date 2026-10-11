import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const isGitRepo = vi.hoisted(() => vi.fn())
vi.mock('@/lib/coworkParallel', () => ({ isGitRepo }))

import {
  resetRepoCache,
  useCampaignFolder,
  useCampaignFolderState,
} from '../useCampaignFolder'
import { useCoworkSessions } from '../useCoworkSessions'

const open = (folder: string | null) =>
  useCoworkSessions.setState({
    sessions: [{ id: 's', folder, updated: 1 }],
    currentId: 's',
  } as never)

describe('useCampaignFolderState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRepoCache()
  })

  it('offers the folder at once while the git check is unknown', async () => {
    isGitRepo.mockReturnValue(new Promise(() => undefined))
    open('/repo')
    const state = renderHook(() => useCampaignFolderState())
    expect(state.result.current).toEqual({ folder: '/repo', isRepo: null })
    const folder = renderHook(() => useCampaignFolder())
    expect(folder.result.current).toBe('/repo')
  })

  it('resolves in the background and remembers the answer for the next open', async () => {
    isGitRepo.mockResolvedValue(false)
    open('/plain')
    const first = renderHook(() => useCampaignFolderState())
    await waitFor(() => expect(first.result.current.isRepo).toBe(false))
    expect(renderHook(() => useCampaignFolder()).result.current).toBeNull()
    // A new mount reads the cached answer on its first render.
    isGitRepo.mockReturnValue(new Promise(() => undefined))
    const second = renderHook(() => useCampaignFolderState())
    expect(second.result.current).toEqual({ folder: '/plain', isRepo: false })
  })
})
