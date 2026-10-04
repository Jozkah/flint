import { describe, it, expect } from 'vitest'
import en from '@/locales/en/permissions.json'
import {
  categorizeTool,
  describePermissionRequest,
  type PermissionMessage,
} from '@/lib/permissionRequest'

/** Resolve a message against the real English bundle, as the UI would. */
const text = (msg: PermissionMessage): string => {
  const [, path] = msg.key.split(':')
  let node: unknown = en
  for (const part of path.split('.')) {
    node = (node as Record<string, unknown>)?.[part]
  }
  expect(typeof node, `missing key ${msg.key}`).toBe('string')
  return (node as string).replace(/\{\{(\w+)\}\}/g, (_, v) =>
    String(msg.values?.[v] ?? `{{${v}}}`)
  )
}

describe('browser actions in the approval prompt', () => {
  const page = 'https://shop.test/cart?id=7&t=abc'

  it('are their own category, not an unknown tool', () => {
    for (const t of ['browser_click', 'browser_type', 'browser_press', 'browser_select']) {
      expect(categorizeTool(t)).toBe('browser')
    }
    // Reads and scrolling never ask, so they are not described here.
    expect(categorizeTool('browser_scroll')).toBe('other')
    // A server's tool of the same name is still an external tool.
    expect(categorizeTool('browser_click', 'someserver')).toBe('external-tool')
  })

  it('a click names the control and the page, in full', () => {
    const d = describePermissionRequest({
      toolName: 'browser_click',
      input: { id: '3.12', control: 'Add to cart', page },
    })
    expect(text(d.action)).toBe(`Flint wants to click "Add to cart" on ${page}`)
    expect(d.resources).toEqual([page, '"Add to cart"'])
    const consequence = d.consequences.map(text).join(' ')
    expect(consequence).not.toMatch(/cannot tell what this tool does/)
    expect(consequence).toMatch(/live web page/)
    expect(d.categoryLabel.key).toBe('permissions:category.browser')
  })

  it('typing shows what will be typed, pressing the key, selecting the option', () => {
    expect(
      text(
        describePermissionRequest({
          toolName: 'browser_type',
          input: { id: '1.2', text: 'hello world', control: 'Search', page },
        }).action
      )
    ).toBe(`Flint wants to type "hello world" into "Search" on ${page}`)
    expect(
      text(
        describePermissionRequest({
          toolName: 'browser_press',
          input: { key: 'Enter', control: 'Search', page },
        }).action
      )
    ).toBe(`Flint wants to press Enter on ${page}`)
    expect(
      text(
        describePermissionRequest({
          toolName: 'browser_select',
          input: { id: '1.3', value: 'Large', control: 'Size', page },
        }).action
      )
    ).toBe(`Flint wants to choose "Large" in "Size" on ${page}`)
  })

  it('still says something useful before the control is known', () => {
    const d = describePermissionRequest({ toolName: 'browser_click', input: { id: '3.12' } })
    expect(text(d.action)).toBe('Flint wants to click the control on the open page')
  })

  it('a secret in the typed text or the address is redacted', () => {
    const d = describePermissionRequest({
      toolName: 'browser_type',
      input: {
        id: '1.2',
        text: 'sk-abcdefghijklmnopqrstuvwxyz123456',
        control: 'Key',
        page: 'https://a.test/?api_key=supersecretvalue123',
      },
    })
    const all = JSON.stringify(d)
    expect(all).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
    expect(all).not.toContain('supersecretvalue123')
  })
})

describe('the interactive browser tool in the approval prompt', () => {
  it('is described as acting on a live page, not as an unknown tool', () => {
    expect(categorizeTool('browser')).toBe('browser')
    const d = describePermissionRequest({
      toolName: 'browser',
      input: { action: 'open', url: 'https://shop.test/cart' },
    })
    expect(text(d.action)).toBe('Flint wants to use its browser: open https://shop.test/cart')
    const consequence = d.consequences.map(text).join(' ')
    expect(consequence).not.toMatch(/cannot tell what this tool does/)
    expect(consequence).toMatch(/live web page/)
  })
})
