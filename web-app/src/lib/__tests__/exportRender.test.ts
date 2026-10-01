import { describe, it, expect } from 'vitest'
import { imageScale, MAX_CANVAS_PX, renderHtmlBody, renderHtmlPage } from '../exportRender'
import type { ExportDoc } from '../exportMarkdown'

const doc: ExportDoc = {
  title: 'T <b>',
  scope: 'thread',
  exportedAt: '2026-10-01T10:00:00.000Z',
  messages: [
    { role: 'user', text: '**bold** <script>alert(1)</script> <img src=x onerror=alert(2)>' },
  ],
}

describe('renderHtmlBody', () => {
  it('renders Markdown but never passes raw HTML through', () => {
    const html = renderHtmlBody(doc)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('wraps the body in a page with a print stylesheet and a safe title', () => {
    const page = renderHtmlPage(doc)
    expect(page).toContain('@media print')
    expect(page).toContain('<title>T  b </title>')
  })
})

describe('imageScale', () => {
  it('draws short pages sharp, long pages at 1x, and refuses past the canvas limit', () => {
    expect(imageScale(2000)).toBe(2)
    expect(imageScale(MAX_CANVAS_PX / 2 + 1)).toBe(1)
    expect(imageScale(MAX_CANVAS_PX)).toBe(1)
    expect(imageScale(MAX_CANVAS_PX + 1)).toBeNull()
  })
})
