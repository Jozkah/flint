import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { ContentType, MessageStatus, type ThreadMessage } from '@janhq/core'

const summarizer = vi.hoisted(() => ({
  regenerateThreadTitle: vi.fn(async () => 'A title'),
  summarizeConversation: vi.fn(async () => 'summary'),
}))
vi.mock('@/lib/thread-title-summarizer', () => summarizer)

const fetchMessages = vi.hoisted(() => vi.fn(async () => [] as ThreadMessage[]))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({
      fetchMessages,
      createMessage: async (m: ThreadMessage) => m,
      modifyMessage: async (m: ThreadMessage) => m,
      deleteMessage: async () => undefined,
    }),
    threads: () => ({ updateThread: async () => undefined }),
  }),
}))

const transcriptSeen = vi.hoisted(() => ({ value: '' as string | Promise<string> }))
vi.mock('@/hooks/usePreviewSummary', () => ({
  usePreviewSummary: (
    _key: string,
    _open: boolean,
    get: () => Promise<string> | string
  ) => {
    transcriptSeen.value = get()
    return { summary: undefined, loading: false }
  },
}))

import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { regenerateTitle } from '../regenerateTitle'
import { stampErrorOnLastUserMessage } from '@/containers/dialogs/llamacppRouterError'
import { ThreadPreviewSummary } from '@/containers/ThreadPreviewSummary'

let clock = 0
const msg = (
  id: string,
  role: 'user' | 'assistant',
  parentId: string | null,
  text = id
): ThreadMessage => ({
  id,
  object: 'thread.message',
  thread_id: 't1',
  role: role as ThreadMessage['role'],
  content: [{ type: ContentType.Text, text: { value: text, annotations: [] } }],
  status: MessageStatus.Ready,
  created_at: ++clock,
  completed_at: clock,
  metadata: { parentId },
})

// The first question was edited: u1 -> a1 is the old version, u1b -> a1b the
// one on screen.
const edited = () => [
  msg('u1', 'user', null, 'old question'),
  msg('a1', 'assistant', 'u1', 'old answer'),
  msg('u1b', 'user', null, 'new question'),
  msg('a1b', 'assistant', 'u1b', 'new answer'),
]

beforeEach(() => {
  vi.clearAllMocks()
  useMessages.setState({ messages: { t1: edited() } })
  useThreads.setState({
    threads: { t1: { id: 't1', title: 'x', metadata: {} } as never },
  })
})

describe('readers of a branched thread', () => {
  it('titles the chat from the shown versions only', async () => {
    expect(await regenerateTitle('t1')).toBe('done')
    const transcript = summarizer.regenerateThreadTitle.mock.calls[0][0] as string
    expect(transcript).toContain('new question')
    expect(transcript).toContain('new answer')
    expect(transcript).not.toContain('old question')
    expect(transcript).not.toContain('old answer')
  })

  it('titles from a fetched thread by its shown versions too', async () => {
    useMessages.setState({ messages: {} })
    fetchMessages.mockResolvedValueOnce(edited())
    await regenerateTitle('t1')
    const transcript = summarizer.regenerateThreadTitle.mock.calls[0][0] as string
    expect(transcript).not.toContain('old')
  })

  it('stamps an error on the shown user turn, not a hidden newer one', () => {
    // A follow-up on the old version is stored last but is not shown.
    const hidden = msg('u9', 'user', 'a1', 'hidden follow-up')
    useMessages.setState({ messages: { t1: [...edited(), hidden] } })
    useAppState.setState({ currentStreamThreadId: 't1' })
    stampErrorOnLastUserMessage('oomError', 'boom')
    const stored = useMessages.getState().getMessages('t1')
    expect(stored.find((x) => x.id === 'u1b')?.metadata?.oomError).toBe('boom')
    expect(stored.find((x) => x.id === 'u9')?.metadata?.oomError).toBeUndefined()
  })

  it('previews only the shown versions', async () => {
    render(<ThreadPreviewSummary open threadId="t1" />)
    const transcript = await transcriptSeen.value
    expect(transcript).toContain('new answer')
    expect(transcript).not.toContain('old answer')
  })
})
