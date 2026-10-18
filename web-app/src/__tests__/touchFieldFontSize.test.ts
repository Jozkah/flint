import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '..', 'index.css'), 'utf8')

// C079/C142: on a phone the composer (a contenteditable, not an input) was
// 13.5px and fields 14px, so iOS zoomed in on focus. The rule only applied to
// iOS WebKit and never covered the composer.
describe('touch text fields are at least 16px', () => {
  it('covers inputs and the contenteditable composer on a touch-only pointer', () => {
    const block = css.match(
      /@media \(pointer: coarse\) and \(hover: none\) \{([\s\S]*?)\n\}/
    )
    expect(block).not.toBeNull()
    const body = block![1]
    for (const sel of ['input', 'textarea', 'select', '[contenteditable']) {
      expect(body).toContain(sel)
    }
    expect(body).toMatch(/font-size:\s*16px/)
  })
})
