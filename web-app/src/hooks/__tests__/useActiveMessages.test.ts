import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({
      createMessage: async (m: ThreadMessage) => m,
      modifyMessage: async (m: ThreadMessage) => m,
      deleteMessage: async () => undefined,
    }),
  }),
}))

import { useMessages } from '../useMessages'
import { useThreads } from '../useThreads'
import { getActiveMessages, useActiveMessages } from '../useActiveMessages'

let clock = 0
const msg = (
  id: string,
  role: 'user' | 'assistant',
  parentId: string | null,
  extra: Record<string, unknown> = {}
): ThreadMessage => ({
  id,
  object: 'thread.message',
  thread_id: 't1',
  role: role as ThreadMessage['role'],
  content: [{ type: ContentType.Text, text: { value: id, annotations: [] } }],
  status: MessageStatus.Ready,
  created_at: ++clock,
  completed_at: clock,
  metadata: { parentId, ...extra },
})

const branched = [
  msg('u1', 'user', null),
  msg('a1', 'assistant', 'u1'),
  msg('a1b', 'assistant', 'u1'),
]

describe('useActiveMessages', () => {
  beforeEach(() => {
    useThreads.setState({ threads: {} })
    useMessages.setState({ messages: { t1: branched } })
  })

  it('returns only the shown versions', () => {
    const { result } = renderHook(() => useActiveMessages('t1'))
    expect(result.current.map((m) => m.id)).toEqual(['u1', 'a1b'])
  })

  it('follows a switch of the active version', () => {
    const { result } = renderHook(() => useActiveMessages('t1'))
    act(() => {
      useMessages.setState({
        messages: {
          t1: [
            { ...branched[0], metadata: { parentId: null, activeChildId: 'a1' } },
            branched[1],
            branched[2],
          ],
        },
      })
    })
    expect(result.current.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(getActiveMessages('t1').map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('is empty for no thread or an unknown one', () => {
    expect(renderHook(() => useActiveMessages(undefined)).result.current).toEqual([])
    expect(renderHook(() => useActiveMessages('nope')).result.current).toEqual([])
  })

  it('reads the selected root from the thread metadata', () => {
    useMessages.setState({
      messages: { t1: [msg('r1', 'user', null), msg('r2', 'user', null)] },
    })
    useThreads.setState({
      threads: { t1: { id: 't1', metadata: { activeRootId: 'r1' } } as never },
    })
    const { result } = renderHook(() => useActiveMessages('t1'))
    expect(result.current.map((m) => m.id)).toEqual(['r1'])
  })
})
