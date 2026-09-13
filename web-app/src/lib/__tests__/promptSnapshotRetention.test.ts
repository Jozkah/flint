import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { deletePromptSnapshots } from '../promptSnapshotRetention'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'

describe('prompt snapshot retention', () => {
  beforeEach(() => invoke.mockReset().mockResolvedValue(1))

  it('asks the backend to delete exactly one session', async () => {
    await deletePromptSnapshots('s-1')
    expect(invoke).toHaveBeenCalledWith('agent_prompt_snapshots_delete', { session: 's-1' })
  })

  it('never asks with an empty session, which would read as "all"', async () => {
    await deletePromptSnapshots('')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not let a failed cleanup stop the deletion', async () => {
    invoke.mockImplementationOnce(async () => {
      throw new Error('disk full')
    })
    await expect(deletePromptSnapshots('s-1')).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('deleting a Cowork session deletes its snapshots', () => {
    useCoworkSessions.setState({ sessions: [], currentId: null })
    const id = useCoworkSessions.getState().createSession()
    useCoworkSessions.getState().deleteSession(id)
    expect(invoke).toHaveBeenCalledWith('agent_prompt_snapshots_delete', { session: id })
  })
})
