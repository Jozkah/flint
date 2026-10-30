import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ThreadMessage } from '@janhq/core'

const h = vi.hoisted(() => ({
  createMessage: vi.fn(async (m: unknown) => m),
  modifyMessage: vi.fn(async (m: unknown) => m),
  deleteMessage: vi.fn(async () => undefined),
  threads: {} as Record<string, { metadata?: Record<string, unknown> }>,
  sessions: {} as Record<string, unknown>,
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({
      createMessage: h.createMessage,
      modifyMessage: h.modifyMessage,
      deleteMessage: h.deleteMessage,
    }),
  }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: h.threads }) },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  i18n: { t: (k: string) => k },
}))
vi.mock('@/lib/redactToolOutput', () => ({
  redactText: async (t: string) => t.replace('sk-secret', '[REDACTED]'),
}))
vi.mock('@/stores/chat-session-store', () => ({
  useChatSessions: { getState: () => ({ sessions: h.sessions }) },
  isSessionBusy: (s: { isStreaming?: boolean }) => !!s?.isStreaming,
}))

import {
  persistInterruptedReplies,
  registerReplyContext,
  resetInterruptedReplies,
  wasPersistedOnQuit,
  INTERRUPTED_TOOL_ERROR,
} from '@/lib/persistInterruptedReplies'
import { useMessages } from '@/hooks/useMessages'

type Session = {
  isStreaming: boolean
  chat: { messages: unknown[]; stop: ReturnType<typeof vi.fn> }
}
const sessions = () => h.sessions as Record<string, Session>

const user = (id: string, threadId: string): ThreadMessage =>
  ({
    id,
    thread_id: threadId,
    role: 'user',
    content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
    created_at: 1,
    metadata: {},
  }) as unknown as ThreadMessage

const stream = (threadId: string, assistant: unknown, streaming = true) => {
  const s: Session = {
    isStreaming: streaming,
    chat: { messages: [{ id: 'u-' + threadId, role: 'user', parts: [] }, assistant], stop: vi.fn() },
  }
  sessions()[threadId] = s
  return s
}

const created = () =>
  h.createMessage.mock.calls.map((c) => c[0] as unknown as ThreadMessage)

beforeEach(() => {
  vi.clearAllMocks()
  resetInterruptedReplies()
  for (const k of Object.keys(sessions())) delete sessions()[k]
  for (const k of Object.keys(h.threads)) delete h.threads[k]
  useMessages.setState({ messages: {} })
})

describe('persistInterruptedReplies', () => {
  it('saves the partial of every streaming thread once, then stops them', async () => {
    for (const t of ['t1', 't2']) {
      h.threads[t] = {}
      useMessages.setState((s) => ({
        messages: { ...s.messages, [t]: [user('u-' + t, t)] },
      }))
    }
    const a = stream('t1', { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Half an es' }] })
    const b = stream('t2', { id: 'a2', role: 'assistant', parts: [{ type: 'reasoning', text: 'thinking' }] })

    await persistInterruptedReplies()

    expect(created().map((m) => m.id).sort()).toEqual(['a1', 'a2'])
    const m1 = created().find((m) => m.id === 'a1')!
    expect(m1.metadata).toMatchObject({ stopped: true, interrupted: 'quit', parentId: 'u-t1' })
    expect(m1.content[0].text?.value).toBe('Half an es')
    // reasoning-only replies are kept
    expect(created().find((m) => m.id === 'a2')!.content[0].type).toBe('reasoning')
    expect(a.chat.stop).toHaveBeenCalled()
    expect(b.chat.stop).toHaveBeenCalled()
    expect(wasPersistedOnQuit('a1')).toBe(true)
    expect(useMessages.getState().getMessages('t1').map((m) => m.id)).toEqual(['u-t1', 'a1'])

    await persistInterruptedReplies()
    expect(h.createMessage).toHaveBeenCalledTimes(2)
  })

  it('marks a tool call in flight as an error and redacts outputs already in', async () => {
    h.threads.t = {}
    useMessages.setState({ messages: { t: [user('u-t', 't')] } })
    stream('t', {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'tool-bash', toolCallId: 'c1', state: 'output-available', input: {}, output: 'key sk-secret' },
        { type: 'tool-bash', toolCallId: 'c2', state: 'input-available', input: { cmd: 'ls' } },
      ],
    })

    await persistInterruptedReplies()

    const tools = created()[0].content as unknown as Array<Record<string, unknown>>
    expect(tools[0].output).toBe('key [REDACTED]')
    expect(tools[1]).toMatchObject({ tool_state: 'output-error', error_text: INTERRUPTED_TOOL_ERROR })
  })

  it('updates a reply a tool step already saved instead of creating it', async () => {
    h.threads.t = {}
    const saved = { ...user('a', 't'), role: 'assistant', metadata: { parentId: 'u-t' }, created_at: 5 } as unknown as ThreadMessage
    useMessages.setState({ messages: { t: [user('u-t', 't'), saved] } })
    stream('t', { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'more' }] })

    await persistInterruptedReplies()

    expect(h.createMessage).not.toHaveBeenCalled()
    const m = h.modifyMessage.mock.calls[0][0] as unknown as ThreadMessage
    expect(m.created_at).toBe(5)
    expect(m.metadata).toMatchObject({ parentId: 'u-t', interrupted: 'quit' })
  })

  it('a continuation replaces the partial it continues', async () => {
    h.threads.t = {}
    const partial = { ...user('p', 't'), role: 'assistant', metadata: { parentId: 'u-t', stopped: true } } as unknown as ThreadMessage
    useMessages.setState({ messages: { t: [user('u-t', 't'), partial] } })
    registerReplyContext('t', () => ({ continueReplaceId: 'p', parentId: null }))
    stream('t', { id: 'c', role: 'assistant', parts: [{ type: 'text', text: 'partial + more' }] })

    await persistInterruptedReplies()

    expect(created()[0].metadata).toMatchObject({ parentId: 'u-t' })
    expect(h.deleteMessage).toHaveBeenCalledWith('t', 'p')
    expect(useMessages.getState().getMessages('t').map((m) => m.id)).toEqual(['u-t', 'c'])
  })

  it('skips the temporary chat, idle sessions and empty replies', async () => {
    h.threads['temporary-chat'] = {}
    h.threads.idle = {}
    h.threads.empty = {}
    stream('temporary-chat', { id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'x' }] })
    stream('idle', { id: 'y', role: 'assistant', parts: [{ type: 'text', text: 'y' }] }, false)
    stream('empty', { id: 'z', role: 'assistant', parts: [{ type: 'text', text: '  ' }] })

    await persistInterruptedReplies()

    expect(h.createMessage).not.toHaveBeenCalled()
  })

  it('gives up waiting after the cap and still stops the chat', async () => {
    h.threads.t = {}
    h.createMessage.mockImplementationOnce(() => new Promise(() => {}))
    const s = stream('t', { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'x' }] })

    await persistInterruptedReplies(20)

    expect(s.chat.stop).toHaveBeenCalled()
  })
})
