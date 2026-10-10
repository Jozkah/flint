import { beforeEach, describe, expect, it, vi } from 'vitest'

const threads = vi.hoisted(() => ({
  state: {} as Record<string, { id: string; metadata?: Record<string, unknown> }>,
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: {
    getState: () => ({
      threads: threads.state,
      updateThread: (id: string, updates: { metadata?: Record<string, unknown> }) => {
        threads.state[id] = { ...threads.state[id], ...updates }
      },
    }),
  },
}))

import { markThreadHasDocuments } from '../threadDocuments'

beforeEach(() => {
  threads.state = {
    t1: { id: 't1', metadata: { project: { id: 'p' }, folders: ['/a'] } },
  }
})

describe('markThreadHasDocuments', () => {
  it('keeps the thread in its project and other metadata', () => {
    markThreadHasDocuments('t1')
    expect(threads.state.t1.metadata).toEqual({
      project: { id: 'p' },
      folders: ['/a'],
      hasDocuments: true,
    })
  })

  it('works on a thread with no metadata', () => {
    threads.state.t2 = { id: 't2' }
    markThreadHasDocuments('t2')
    expect(threads.state.t2.metadata).toEqual({ hasDocuments: true })
  })
})
