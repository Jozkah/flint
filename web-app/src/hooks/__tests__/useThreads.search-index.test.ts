import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/archive', () => ({
  archiveEnabled: async () => false,
  trackArchiveWork: (p: Promise<unknown>) => p,
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    threads: () => ({
      updateThread: vi.fn(async () => {}),
      deleteThread: vi.fn(async () => {}),
    }),
    path: () => ({ sep: () => '/' }),
  }),
}))

import { useThreads } from '../useThreads'

describe('thread search index', () => {
  beforeEach(() => {
    useThreads.getState().setThreads([
      { id: 't1', title: 'Quokka notes', model: { id: 'a', provider: 'openai' } } as never,
      { id: 't2', title: 'Other', model: { id: 'a', provider: 'openai' } } as never,
    ])
  })

  it('is not rebuilt by writes, only by the next search', () => {
    expect(useThreads.getState().searchIndex).toBeNull()
    useThreads.getState().getFilteredThreads('Quokka')
    expect(useThreads.getState().searchIndex).not.toBeNull()
    useThreads.getState().updateThreadTimestamp('t1')
    expect(useThreads.getState().searchIndex).toBeNull()
  })

  it('returns the live thread after a model change', () => {
    useThreads.getState().getFilteredThreads('Quokka')
    useThreads.getState().updateThreadModel('t1', { id: 'b', provider: 'openai' } as never)
    const hit = useThreads.getState().getFilteredThreads('Quokka')
    expect(hit).toHaveLength(1)
    expect(hit[0].model?.id).toBe('b')
  })

  it('finds a renamed thread under its new title', () => {
    useThreads.getState().getFilteredThreads('Quokka')
    useThreads.getState().renameThread('t2', 'Wombat')
    expect(useThreads.getState().getFilteredThreads('Wombat').map((t) => t.id)).toEqual(['t2'])
  })
})
