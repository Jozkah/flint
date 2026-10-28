import { describe, it, expect, beforeEach, vi } from 'vitest'

const updateThread = vi.fn()

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/archive', () => ({
  archiveEnabled: async () => false,
  trackArchiveWork: (p: Promise<unknown>) => p,
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    threads: () => ({
      updateThread: (t: unknown) => updateThread(t),
      deleteThread: vi.fn(async () => {}),
    }),
    path: () => ({ sep: () => '/' }),
  }),
}))

import { useThreads } from '../useThreads'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('a failed thread write rolls back only its own change', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useThreads.setState({
      threads: { t1: { id: 't1', title: 'Old' } as Thread },
      currentThreadId: 't1',
      searchIndex: null,
    })
  })

  it('does not undo a later edit', async () => {
    updateThread.mockRejectedValueOnce(new Error('disk'))
    useThreads.getState().renameThread('t1', 'New')
    // A newer edit lands before the failure is reported.
    useThreads.getState().toggleFavorite('t1')
    await flush()
    const t = useThreads.getState().threads.t1
    expect(t.isFavorite).toBe(true)
  })

  it('rolls back when nothing newer touched the thread', async () => {
    updateThread.mockRejectedValueOnce(new Error('disk'))
    useThreads.getState().renameThread('t1', 'New')
    await flush()
    expect(useThreads.getState().threads.t1.title).toBe('Old')
  })

  it('does not resurrect a deleted thread', async () => {
    updateThread.mockRejectedValueOnce(new Error('disk'))
    useThreads.getState().renameThread('t1', 'New')
    await useThreads.getState().deleteThreadAsync('t1')
    await flush()
    expect(useThreads.getState().threads.t1).toBeUndefined()
  })

  it('updateThreadModel stores the object it persisted', async () => {
    useThreads.getState().updateThreadModel('t1', {
      id: 'm',
      provider: 'p',
    } as never)
    await flush()
    expect(updateThread.mock.calls[0][0]).toBe(useThreads.getState().threads.t1)
  })
})
