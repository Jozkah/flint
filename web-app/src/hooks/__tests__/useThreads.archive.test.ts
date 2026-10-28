import { describe, it, expect, beforeEach, vi } from 'vitest'

const archiveEnabled = vi.fn()
const cleanupThreadWorkspace = vi.fn()
const deleteCollection = vi.fn()

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({ get: () => ({ deleteCollection }) }),
  },
}))

vi.mock('@/lib/archive', () => ({
  archiveEnabled: () => archiveEnabled(),
  trackArchiveWork: (p: Promise<unknown>) => p,
}))
vi.mock('@/lib/agentTools', () => ({
  cleanupThreadWorkspace: (id: string) => cleanupThreadWorkspace(id),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    threads: () => ({ deleteThread: vi.fn(async () => {}) }),
    path: () => ({ sep: () => '/' }),
  }),
}))

import { useThreads } from '../useThreads'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('deleting a thread with the archive on', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useThreads.setState({
      threads: { t1: { id: 't1', title: 'T' } as Thread },
      searchIndex: null,
    })
  })

  it('keeps the sandbox so a restored thread still has it', async () => {
    archiveEnabled.mockResolvedValue(true)
    useThreads.getState().deleteThread('t1')
    await flush()
    expect(cleanupThreadWorkspace).not.toHaveBeenCalled()
  })

  it('removes it when the delete is permanent', async () => {
    archiveEnabled.mockResolvedValue(true)
    useThreads.getState().deleteThread('t1', true)
    await flush()
    expect(cleanupThreadWorkspace).toHaveBeenCalledWith('t1')
  })

  it('removes it when the archive is off', async () => {
    archiveEnabled.mockResolvedValue(false)
    useThreads.getState().deleteThread('t1')
    await flush()
    expect(cleanupThreadWorkspace).toHaveBeenCalledWith('t1')
  })

  it('passes the bare thread id to the vector db, which adds its own prefix', async () => {
    archiveEnabled.mockResolvedValue(false)
    useThreads.getState().deleteThread('t1')
    await flush()
    expect(deleteCollection).toHaveBeenCalledWith('t1')
  })
})
