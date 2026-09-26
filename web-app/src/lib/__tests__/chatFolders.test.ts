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

import {
  chatFolderAdapter,
  chatFolderToolOptions,
  chatFoldersOf,
  setChatFolders,
} from '../chatFolders'

beforeEach(() => {
  threads.state = { t1: { id: 't1', metadata: { project: { id: 'p' } } } }
})

describe('chat folders', () => {
  it('a chat has none until some are attached', () => {
    expect(chatFoldersOf(threads.state.t1 as Thread)).toEqual([])
    expect(chatFolderToolOptions('t1')).toEqual({})
  })

  it('are stored on the metadata, deduplicated, beside what is there', () => {
    setChatFolders('t1', ['C:/a', 'c:\\a', 'C:/b'])
    expect(threads.state.t1.metadata).toEqual({
      project: { id: 'p' },
      folders: ['C:/a', 'C:/b'],
    })
  })

  it('reach the agent tools as the read-only project and extra projects', () => {
    setChatFolders('t1', ['/a', '/b', '/c'])
    expect(chatFolderToolOptions('t1')).toEqual({
      readOnlyProject: '/a',
      extraProjects: ['/b', '/c'],
    })
  })

  it('the adapter attaches and detaches through the metadata', async () => {
    await chatFolderAdapter.attach('t1', ['/a', '/b'])
    expect(await chatFolderAdapter.attached('t1')).toEqual(['/a', '/b'])
    await chatFolderAdapter.detach('t1', ['/a'])
    expect(await chatFolderAdapter.attached('t1')).toEqual(['/b'])
  })
})
