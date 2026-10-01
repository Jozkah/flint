import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({
      createMessage: async (m: ThreadMessage) => m,
      modifyMessage: async (m: ThreadMessage) => m,
      deleteMessage: async () => undefined,
    }),
    threads: () => ({ updateThread: async () => undefined }),
  }),
}))

import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { selectVersion } from '../branchSelect'
import { activePathOf } from '../message-branching'

let clock = 0
const msg = (
  id: string,
  role: 'user' | 'assistant',
  parentId: string | null
): ThreadMessage => ({
  id,
  object: 'thread.message',
  thread_id: 't1',
  role: role as ThreadMessage['role'],
  content: [{ type: ContentType.Text, text: { value: id, annotations: [] } }],
  status: MessageStatus.Ready,
  created_at: ++clock,
  completed_at: clock,
  metadata: { parentId },
})

const shown = () =>
  activePathOf(
    useMessages.getState().getMessages('t1'),
    useThreads.getState().threads.t1?.metadata
  ).map((m) => m.id)

beforeEach(() => {
  useMessages.setState({
    messages: {
      t1: [
        msg('u1', 'user', null),
        msg('a1', 'assistant', 'u1'),
        msg('a1b', 'assistant', 'u1'),
        msg('r2', 'user', null),
      ],
    },
  })
  useThreads.setState({
    threads: { t1: { id: 't1', title: 't', metadata: {} } as never },
  })
})

describe('selectVersion', () => {
  it('steps a reply back and forward among its versions', () => {
    // r2 is the newest root, so the shown path starts there; pick u1 first.
    selectVersion('t1', 'r2', -1)
    expect(shown()).toEqual(['u1', 'a1b'])
    expect(selectVersion('t1', 'a1b', -1)?.id).toBe('a1')
    expect(shown()).toEqual(['u1', 'a1'])
    expect(selectVersion('t1', 'a1', 1)?.id).toBe('a1b')
    expect(shown()).toEqual(['u1', 'a1b'])
  })

  it('selects between roots through the thread', () => {
    selectVersion('t1', 'r2', -1)
    expect(useThreads.getState().threads.t1.metadata?.activeRootId).toBe('u1')
  })

  it('does nothing past the ends or for an unknown message', () => {
    expect(selectVersion('t1', 'a1', -1)).toBeNull()
    expect(selectVersion('t1', 'a1b', 1)).toBeNull()
    expect(selectVersion('t1', 'nope', 1)).toBeNull()
  })
})
