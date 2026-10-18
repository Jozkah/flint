import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '../markdown.css'), 'utf8')

describe('markdown.css', () => {
  it('keeps list markers outside so wrapped lines hang', () => {
    expect(css).not.toMatch(/list-style-position:\s*inside/)
    expect(css).toMatch(/list-style-position:\s*outside/)
  })
  it('does not inline list-item paragraphs', () => {
    expect(css).not.toMatch(/display:\s*inline;/)
  })
  it('hides the bullet beside task-list checkboxes', () => {
    expect(css).toMatch(/li\.task-list-item\s*\{\s*list-style:\s*none/)
  })
  it('never breaks table cells mid-word', () => {
    expect(css).toMatch(/td\s*\{[^}]*overflow-wrap:\s*normal/)
  })
})

describe('markdown.css code blocks', () => {
  it('caps long code blocks with an inner scroll', () => {
    expect(css).toMatch(/max-height:\s*max\(8rem,\s*60vh\)/)
    expect(css).toMatch(/\[data-code-expanded\][^{]*\{\s*max-height:\s*none/)
  })
})
