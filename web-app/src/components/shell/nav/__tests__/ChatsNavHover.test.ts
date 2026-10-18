import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ChatsNav pulls in routing, threads and dialogs; the hover scope is a class
// contract, so it is checked on the source.
const src = readFileSync(resolve(__dirname, '../ChatsNav.tsx'), 'utf8')

describe('ChatsNav folder hover scope', () => {
  it('puts the hover group on the header row, not the whole folder', () => {
    const container = src.match(
      /<div key=\{g\.id\} className="([^"]*)" data-testid="chat-group"/
    )
    expect(container?.[1]).not.toMatch(/group\/cg/)
    const header = src.match(
      /<div className="([^"]*)" data-testid="chat-group-header"/
    )
    expect(header?.[1]).toMatch(/group\/cg/)
  })

  it('reveals the controls for keyboard focus inside the header, not for a mouse click that left focus there', () => {
    const actions = src.match(/opacity-0 group-hover\/cg:opacity-100[^"]*/g) ?? []
    expect(actions.length).toBeGreaterThanOrEqual(2)
    for (const a of actions) {
      expect(a).toContain('group-has-[:focus-visible]/cg:opacity-100')
      // focus-within also matched the leftover focus of a mouse click, which
      // kept one folder's controls lit while another was hovered.
      expect(a).not.toContain('group-focus-within')
    }
  })
})
