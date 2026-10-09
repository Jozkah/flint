import { describe, it, expect, vi } from 'vitest'
import { importConversations, parseChatGptExport } from '../chatgptImport'

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
})
