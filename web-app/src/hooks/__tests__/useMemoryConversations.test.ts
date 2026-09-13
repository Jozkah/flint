import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useMemoryConversations } from '../useMemoryConversations'
import { useCoworkSessions } from '../useCoworkSessions'
import { useThreads } from '../useThreads'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

describe('useMemoryConversations', () => {
  beforeEach(() => {
    act(() => {
      useCoworkSessions.setState({
        sessions: [
          { id: 'cw-old', title: 'Old run', folder: 'C:/repos/jan', turns: [], messages: [], updated: 1 },
          { id: 'cw-new', title: 'New run', folder: 'C:/repos/jan', turns: [], messages: [], updated: 30 },
          { id: 'cw-other', title: 'Other', folder: 'C:/repos/other', turns: [], messages: [], updated: 5 },
        ] as never,
        currentId: null,
      })
      useThreads.setState({
        threads: {
          t1: { id: 't1', title: 'A chat', updated: 20 },
          [TEMPORARY_CHAT_ID]: { id: TEMPORARY_CHAT_ID, title: 'temp', updated: 99 },
        } as never,
      })
    })
  })

  it('lists every conversation by its own id, most recent first, without the temporary chat', () => {
    const { result } = renderHook(() => useMemoryConversations())
    expect(result.current.sessions.map((s) => [s.id, s.kind])).toEqual([
      ['cw-new', 'cowork'],
      ['t1', 'chat'],
      ['cw-other', 'cowork'],
      ['cw-old', 'cowork'],
    ])
  })

  it('offers each attached project folder once', () => {
    const { result } = renderHook(() => useMemoryConversations())
    expect(result.current.projects).toEqual(['C:/repos/jan', 'C:/repos/other'])
  })
})
