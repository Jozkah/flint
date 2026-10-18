import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '..', '..', 'index.css'), 'utf8')

describe('toasts stay clickable while a modal is open', () => {
  it('visible sonner cards take pointer events back from a modal body', () => {
    // Radix sets `pointer-events: none` on <body> for a modal and the cards
    // inherit it, so an approval toast raised over a dialog could not be hit.
    const rule = css.match(
      /\.toaster \[data-sonner-toast\]:not\(\[data-visible='false'\]\)\s*\{([^}]*)\}/
    )
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/pointer-events:\s*auto/)
  })
})
