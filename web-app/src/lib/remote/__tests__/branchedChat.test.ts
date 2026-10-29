import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'

const store = vi.hoisted(() => ({ messages: [] as ThreadMessage[] }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({
      fetchMessages: async () => store.messages,
      createMessage: async (m: ThreadMessage) => m,
      modifyMessage: async (m: ThreadMessage) => m,
      deleteMessage: async () => undefined,
    }),
    threads: () => ({ updateThread: async () => undefined }),
  }),
}))

import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { BRANCH_CHANGED_EVENT } from '@/lib/branchSelect'
import { appSources } from '../sources'
import { appExtras } from '../appExtras'

let clock = 0
const msg = (
  id: string,
  role: 'user' | 'assistant',
  parentId: string | null
): ThreadMessage => ({
  id,
  object: 'thread.message',
  thread_id: 'c1',
  role: role as ThreadMessage['role'],
  content: [{ type: ContentType.Text, text: { value: id, annotations: [] } }],
  status: MessageStatus.Ready,
  created_at: ++clock,
  completed_at: clock,
  metadata: { parentId },
})

const branched = () => [
  msg('u1', 'user', null),
  msg('a1', 'assistant', 'u1'),
  msg('a1b', 'assistant', 'u1'),
]

beforeEach(() => {
  store.messages = branched()
  useMessages.setState({ messages: { c1: store.messages } })
  useThreads.setState({
    threads: { c1: { id: 'c1', title: 'c', metadata: {} } as never },
  })
  useAppState.setState({ busyThreads: {}, currentStreamThreadId: undefined })
})

describe('a branched chat on the phone', () => {
  it('sends the version in force, with its position', async () => {
    const out = await appSources.chatMessages('c1')
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1b'])
    expect(out[0].versions).toBeUndefined()
    expect(out[1].versions).toEqual({ index: 2, count: 2 })
  })

  it('sends a plain chat unchanged, with no version fields', async () => {
    store.messages = [
      { ...msg('x', 'user', null), metadata: {} },
      { ...msg('y', 'assistant', null), metadata: {} },
    ]
    const out = await appSources.chatMessages('c1')
    expect(out.map((m) => m.id)).toEqual(['x', 'y'])
    expect(out.every((m) => !('versions' in m))).toBe(true)
  })

  it('steps a version, and tells an open chat on the desktop', async () => {
    const seen = vi.fn()
    window.addEventListener(BRANCH_CHANGED_EVENT, seen)
    expect(appExtras.selectVersion('c1', 'a1b', -1)).toBe(true)
    window.removeEventListener(BRANCH_CHANGED_EVENT, seen)
    expect(seen).toHaveBeenCalledTimes(1)
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ threadId: 'c1' })
    const u1 = useMessages.getState().getMessages('c1').find((m) => m.id === 'u1')
    expect(u1?.metadata?.activeChildId).toBe('a1')
  })

  it('refuses to switch under a reply being written', () => {
    useAppState.setState({ busyThreads: { c1: true } })
    expect(appExtras.selectVersion('c1', 'a1b', -1)).toBe(false)
    useAppState.setState({ busyThreads: {}, currentStreamThreadId: 'c1' })
    expect(appExtras.selectVersion('c1', 'a1b', -1)).toBe(false)
  })

  it('says no for a missing version', () => {
    expect(appExtras.selectVersion('c1', 'a1', -1)).toBe(false)
  })
})

describe('chat and Cowork messages on the phone', () => {
  it('converts one page of a chat, the same as paging the whole chat', async () => {
    store.messages = Array.from({ length: 6 }, (_, i) => ({
      ...msg(`m${i}`, i % 2 ? 'assistant' : 'user', null),
      metadata: {},
    }))
    const all = await appSources.chatMessages('c1')
    const page = await appSources.chatMessagesPage!('c1', 4, 2)
    expect(page).toEqual({ items: all.slice(2, 4), start: 2, total: 6 })
    expect(await appSources.chatMessagesPage!('missing', undefined, 2)).toEqual({ items: [], start: 0, total: 0 })
  })

  it("gives each Cowork message its own stored time, falling back to the session's", () => {
    useCoworkSessions.setState({
      sessions: [
        {
          id: 'w1',
          updated: 999,
          messages: [
            { id: 'a', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { createdAt: 100 } },
            {
              id: 'b',
              role: 'assistant',
              parts: [{ type: 'text', text: 'yo' }],
              metadata: { createdAt: '1970-01-01T00:00:00.200Z' },
            },
            { id: 'c', role: 'assistant', parts: [{ type: 'text', text: 'old' }] },
          ],
        } as never,
      ],
    })
    expect(appSources.coworkMessages('w1')?.map((m) => m.createdAt)).toEqual([100, 200, 999])
  })
})
