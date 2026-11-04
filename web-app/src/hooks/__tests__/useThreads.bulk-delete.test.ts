import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/archive', () => ({
  archiveEnabled: async () => false,
  trackArchiveWork: (p: Promise<unknown>) => p,
}))
vi.mock('@/lib/agentTools', () => ({
  cleanupThreadWorkspace: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    threads: () => ({ deleteThread: vi.fn(async () => {}) }),
    path: () => ({ sep: () => '/' }),
  }),
}))

import { useThreads } from '../useThreads'
import { useToolApproval } from '../useToolApproval'
import { useWorkProfiles } from '../useWorkProfiles'
import { useWebSearchChoice } from '../useWebSearchChoice'

const thread = (id: string, extra: Partial<Thread> = {}) =>
  ({ id, title: id, ...extra }) as Thread

const grantAll = () => {
  for (const id of ['t1', 'fav', 'proj']) {
    useToolApproval.getState().approveToolForThread(id, 'bash')
  }
}

describe('a thread delete forgets its persisted work profile and web search choice', () => {
  beforeEach(() => {
    useThreads.setState({
      threads: { t1: thread('t1'), t2: thread('t2') },
      currentThreadId: 't2',
      searchIndex: null,
    })
    useWorkProfiles.setState({
      sessions: { t1: { id: 'execute', manual: true }, t2: { id: 'review', manual: true } },
    })
    useWebSearchChoice.setState({ byScope: { t1: true, t2: false } })
  })

  it('deleteThread drops that thread from both maps and no other', () => {
    useThreads.getState().deleteThread('t1')
    expect(Object.keys(useWorkProfiles.getState().sessions)).toEqual(['t2'])
    expect(Object.keys(useWebSearchChoice.getState().byScope)).toEqual(['t2'])
  })
})

describe('bulk thread deletes forget per-thread state', () => {
  beforeEach(() => {
    useToolApproval.setState({ approvedTools: {}, approvedMcpTools: {} })
    useThreads.setState({
      threads: {
        t1: thread('t1'),
        fav: thread('fav', { isFavorite: true }),
        proj: thread('proj', {
          metadata: { project: { id: 'p1' } },
        } as Partial<Thread>),
      },
      currentThreadId: 't1',
      searchIndex: null,
    })
    grantAll()
  })

  it('deleteAllThreads revokes grants only for deleted threads', () => {
    useThreads.getState().deleteAllThreads()
    expect(
      Object.keys(useToolApproval.getState().approvedTools).sort()
    ).toEqual(['fav', 'proj'])
  })

  it('deleteAllThreads clears the selection when it was deleted', () => {
    useThreads.getState().deleteAllThreads()
    expect(useThreads.getState().currentThreadId).toBeUndefined()
  })

  it('deleteAllThreads keeps the selection when that thread is kept', () => {
    useThreads.setState({ currentThreadId: 'fav' })
    useThreads.getState().deleteAllThreads()
    expect(useThreads.getState().currentThreadId).toBe('fav')
  })

  it('clearAllThreads revokes every grant', () => {
    useThreads.getState().clearAllThreads()
    expect(useToolApproval.getState().approvedTools).toEqual({})
  })

  it('deleteAllThreadsByProject revokes grants of that project only', () => {
    useThreads.setState({ currentThreadId: 'proj' })
    useThreads.getState().deleteAllThreadsByProject('p1')
    expect(
      Object.keys(useToolApproval.getState().approvedTools).sort()
    ).toEqual(['fav', 't1'])
    expect(useThreads.getState().currentThreadId).toBeUndefined()
  })

  it('deleteThreadAsync revokes that thread grant', async () => {
    await useThreads.getState().deleteThreadAsync('t1')
    expect(useToolApproval.getState().approvedTools.t1).toBeUndefined()
    expect(useToolApproval.getState().approvedTools.fav).toBeDefined()
  })
})
