import { describe, it, expect, vi } from 'vitest'
import {
  importConversations,
  parseChatGptExport,
  parseChatGptExportCounted,
} from '../chatgptImport'
import { computeActivePath } from '../message-branching'
import { convertThreadMessagesToUIMessages } from '../messages'

const node = (
  id: string,
  parent: string | null,
  children: string[],
  role?: string,
  parts?: unknown[]
) => ({
  id,
  parent,
  children,
  message: role
    ? {
        author: { role },
        create_time: 1700000000 + id.length,
        content: { content_type: 'text', parts },
      }
    : null,
})

// root -> system -> user "Hi" -> [assistant "old answer", assistant "new answer"
// -> user "Thanks" -> assistant "Welcome"]; current_node is the last one.
const first = {
  title: 'Greeting',
  create_time: 1700000000,
  update_time: 1700000100,
  current_node: 'a3',
  mapping: {
    root: node('root', null, ['sys']),
    sys: node('sys', 'root', ['u1'], 'system', ['']),
    u1: node('u1', 'sys', ['a1', 'a2'], 'user', ['Hi']),
    a1: node('a1', 'u1', [], 'assistant', ['old answer']),
    a2: node('a2', 'u1', ['u2'], 'assistant', ['new answer']),
    u2: node('u2', 'a2', ['a3'], 'user', ['Thanks']),
    a3: node('a3', 'u2', [], 'assistant', ['Welcome']),
  },
}

const fixture = [
  first,
  {
    title: null,
    mapping: {
      root: node('root', null, ['u1']),
      u1: node('u1', 'root', ['t'], 'user', ['hello', { asset_pointer: 'x' }]),
      t: node('t', 'u1', [], 'tool', ['hidden tool output']),
    },
  },
  { title: 'Empty', mapping: { root: node('root', null, []) } },
]

describe('parseChatGptExport', () => {
  it('keeps the current branch and drops system, tool and empty turns', () => {
    const [one, two, ...rest] = parseChatGptExport(JSON.stringify(fixture))
    expect(rest).toEqual([])
    expect(one.title).toBe('Greeting')
    expect(one.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'new answer'],
      ['user', 'Thanks'],
      ['assistant', 'Welcome'],
    ])
    expect(two.title).toBe('Imported chat')
    expect(two.messages).toHaveLength(1)
    expect(two.messages[0].text).toBe('hello')
  })

  it('follows the newest child when there is no current_node', () => {
    const withoutCurrent = { ...first, current_node: null }
    const [conversation] = parseChatGptExport(JSON.stringify([withoutCurrent]))
    expect(conversation.messages.at(-1)?.text).toBe('Welcome')
  })

  it('rejects text that is not an export', () => {
    expect(() => parseChatGptExport('nope')).toThrow('Not valid JSON')
    expect(() => parseChatGptExport('{}')).toThrow('Not a ChatGPT export')
  })
})

describe('importConversations', () => {
  it('creates a thread then ordered messages, and counts failures', async () => {
    const conversations = parseChatGptExport(JSON.stringify(fixture))
    const createThread = vi
      .fn()
      .mockImplementationOnce(async (t) => t)
      .mockRejectedValueOnce(new Error('disk full'))
    const createMessage = vi.fn(async (m) => m)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await importConversations(conversations, {
      createThread,
      createMessage,
    })
    spy.mockRestore()
    expect(result.threads).toHaveLength(1)
    expect(result.failed).toBe(1)
    const stamps = createMessage.mock.calls.map(([m]) => m.created_at)
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
    expect(new Set(stamps).size).toBe(stamps.length)
    expect(createMessage.mock.calls[0][0].thread_id).toBe(result.threads[0].id)
  })

  it('files messages under the id the backend assigned, not the one sent', async () => {
    const conversations = parseChatGptExport(JSON.stringify(fixture))
    const createThread = vi.fn(async (t) => ({ ...t, id: 'backend-uuid' }))
    const createMessage = vi.fn(async (m) => m)
    await importConversations(conversations, { createThread, createMessage })
    expect(createThread.mock.calls[0][0].id).not.toBe('backend-uuid')
    expect(createMessage.mock.calls.length).toBeGreaterThan(0)
    for (const [m] of createMessage.mock.calls) {
      expect(m.thread_id).toBe('backend-uuid')
    }
  })
})

const modern = (extra: Record<string, unknown> = {}) => ({
  title: 'Modern',
  current_node: 'final',
  mapping: {
    root: { id: 'root', parent: null, children: ['ctx'], message: null },
    ctx: {
      id: 'ctx',
      parent: 'root',
      children: ['u'],
      message: {
        author: { role: 'user' },
        content: { content_type: 'user_editable_context', user_profile: 'x' },
      },
    },
    u: {
      id: 'u',
      parent: 'ctx',
      children: ['th'],
      message: {
        author: { role: 'user' },
        create_time: 1,
        content: {
          content_type: 'multimodal_text',
          parts: [{ content_type: 'audio_transcription', text: 'spoken hi' }],
        },
      },
    },
    th: {
      id: 'th',
      parent: 'u',
      children: ['rc'],
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'thoughts', thoughts: [{ content: 'hmm' }] },
      },
    },
    rc: {
      id: 'rc',
      parent: 'th',
      children: ['final'],
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'reasoning_recap', content: 'Thought for 3s' },
      },
    },
    final: {
      id: 'final',
      parent: 'rc',
      children: [],
      message: {
        author: { role: 'assistant' },
        create_time: 2,
        content: { content_type: 'text', parts: ['final answer'] },
      },
    },
  },
  ...extra,
})

describe('current export shapes', () => {
  it('reads object parts with text and skips thoughts and context', () => {
    const [c] = parseChatGptExport(JSON.stringify([modern()]))
    expect(c.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'spoken hi'],
      ['assistant', 'final answer'],
    ])
  })

  it('accepts a wrapped conversations list', () => {
    const out = parseChatGptExport(JSON.stringify({ conversations: [modern()] }))
    expect(out).toHaveLength(1)
  })

  it('falls back to the newest path when current_node is a hidden dead end', () => {
    const conv = modern({ current_node: 'ctx' })
    const [c] = parseChatGptExport(JSON.stringify([conv]))
    expect(c.messages).toHaveLength(2)
  })

  it('keeps nodes whose map key differs from a missing id', () => {
    const conv = modern({ current_node: undefined })
    for (const n of Object.values(conv.mapping)) delete (n as { id?: string }).id
    const [c] = parseChatGptExport(JSON.stringify([conv]))
    expect(c.messages).toHaveLength(2)
  })

  it('imported messages load into the chat transcript', async () => {
    const conversations = parseChatGptExport(JSON.stringify([modern()]))
    const saved: any[] = []
    await importConversations(conversations, {
      createThread: async (t) => t,
      createMessage: async (m) => {
        saved.push(m)
        return m
      },
    })
    const ui = convertThreadMessagesToUIMessages(computeActivePath(saved))
    expect(ui).toHaveLength(2)
    expect(JSON.stringify(ui[1].parts)).toContain('final answer')
  })

  it('counts conversations that hold no visible messages', () => {
    const hidden = modern()
    for (const n of Object.values(hidden.mapping)) {
      const m = (n as { message?: { content: unknown } | null }).message
      if (m) m.content = { content_type: 'thoughts' }
    }
    const r = parseChatGptExportCounted(JSON.stringify([hidden, hidden]))
    expect(r).toMatchObject({ total: 2, conversations: [] })
  })
})
