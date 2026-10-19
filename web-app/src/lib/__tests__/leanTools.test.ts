import { describe, expect, it } from 'vitest'
import { LOW_VALUE_TOOLS, SMALL_WINDOW_TOKENS, toolsForConversation, toolsForWindow } from '../leanTools'

const all = {
  image_search: 1,
  list_plugins: 2,
  show_widget: 3,
  visualize_read_me: 4,
  web_fetch: 5,
  web_search: 6,
  read: 7,
}

describe('toolsForWindow', () => {
  it('drops the low-value tools for a 32K window when the setting is on', () => {
    const out = toolsForWindow(all, 32_768, true)
    expect(Object.keys(out)).toEqual(['web_fetch', 'web_search', 'read'])
    for (const name of LOW_VALUE_TOOLS) expect(out).not.toHaveProperty(name)
  })

  it('keeps every tool for a large or unknown window', () => {
    expect(toolsForWindow(all, SMALL_WINDOW_TOKENS + 1, true)).toBe(all)
    expect(toolsForWindow(all, 0, true)).toBe(all)
  })

  it('keeps every tool when the user turned the setting off', () => {
    expect(toolsForWindow(all, 8_192, false)).toBe(all)
  })
})

describe('toolsForConversation', () => {
  const tools = { read: 1, docker: 2, computer: 3, git_inspect: 4, web_search: 5 }
  const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] })

  it('drops specialist tools for a plain message', () => {
    expect(Object.keys(toolsForConversation(tools, [user('test')], true))).toEqual([
      'read',
      'web_search',
    ])
  })

  it('offers a specialist tool once the user mentions its subject', () => {
    const out = toolsForConversation(tools, [user('why is my docker container down')], true)
    expect(Object.keys(out)).toEqual(['read', 'docker', 'web_search'])
  })

  it('keeps a tool the conversation already called, and everything when off', () => {
    const called = { role: 'assistant', parts: [{ type: 'tool-computer' }] }
    expect(toolsForConversation(tools, [user('hi'), called], true)).toHaveProperty('computer')
    expect(toolsForConversation(tools, [user('test')], false)).toBe(tools)
  })
})
