import { describe, expect, it } from 'vitest'
import { LOW_VALUE_TOOLS, SMALL_WINDOW_TOKENS, toolsForWindow } from '../leanTools'

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
