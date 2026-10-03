import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadMessage } from '@janhq/core'

const threadsState = vi.hoisted(() => ({ threads: {} as Record<string, unknown> }))
const messagesState = vi.hoisted(() => ({ all: [] as unknown[] }))
const coworkState = vi.hoisted(() => ({ createFromTurns: vi.fn(() => 'session-1') }))
vi.mock('@/hooks/useThreads', () => ({ useThreads: { getState: () => threadsState } }))
vi.mock('@/hooks/useMessages', () => ({
  useMessages: { getState: () => ({ getMessages: () => messagesState.all }) },
}))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: { getState: () => coworkState },
}))

import { chatToTurns, convertChatToCowork } from '../convertChatToCowork'

const msg = (id: string, role: string, parts: unknown[], parent: string | null) =>
  ({
    id,
    thread_id: 't1',
    role,
    content: parts,
    created_at: 1,
    metadata: { parentId: parent },
  }) as unknown as ThreadMessage
const text = (value: string) => ({ type: 'text', text: { value, annotations: [] } })

beforeEach(() => {
  threadsState.threads = { t1: { id: 't1', title: 'Cache bug' } }
  messagesState.all = []
  coworkState.createFromTurns.mockClear()
})

describe('chatToTurns', () => {
  it('keeps user and assistant text, drops reasoning and tool parts', () => {
    const turns = chatToTurns([
      msg('u1', 'user', [text('hi')], null),
      msg(
        'a1',
        'assistant',
        [{ type: 'reasoning', text: { value: 'hmm' } }, text('hello'), { type: 'tool_call' }],
        'u1'
      ),
    ])
    expect(turns).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('carries data-URL images on user turns only', () => {
    const turns = chatToTurns([
      msg(
        'u1',
        'user',
        [
          text('look'),
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'image_url', image_url: { url: 'https://x/y.png' } },
        ],
        null
      ),
    ])
    expect(turns[0].images).toEqual(['data:image/png;base64,AAA'])
  })

  it('skips rows with nothing to show', () => {
    expect(chatToTurns([msg('u1', 'user', [], null)])).toEqual([])
  })
})

describe('convertChatToCowork', () => {
  it('creates a session titled like the chat', async () => {
    messagesState.all = [msg('u1', 'user', [text('hi')], null)]
    const id = await convertChatToCowork('t1', async () => [])
    expect(id).toBe('session-1')
    expect(coworkState.createFromTurns).toHaveBeenCalledWith('Cache bug', [
      { role: 'user', content: 'hi' },
    ])
  })

  it('loads messages from disk when none are in memory', async () => {
    const load = vi.fn(async () => [msg('u1', 'user', [text('hi')], null)])
    expect(await convertChatToCowork('t1', load)).toBe('session-1')
    expect(load).toHaveBeenCalledWith('t1')
  })

  it('returns null for an empty or unknown chat', async () => {
    expect(await convertChatToCowork('t1', async () => [])).toBeNull()
    expect(await convertChatToCowork('nope', async () => [])).toBeNull()
    expect(coworkState.createFromTurns).not.toHaveBeenCalled()
  })
})
