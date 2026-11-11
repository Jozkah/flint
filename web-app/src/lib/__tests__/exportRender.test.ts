import { describe, it, expect } from 'vitest'
import { imageScale, MAX_CANVAS_PX, pdfStrategy, renderHtmlBody, renderHtmlPage } from '../exportRender'
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

describe('pdfStrategy', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2'
  it('prints on Windows when print exists', () => {
    expect(pdfStrategy({ platform: win, canPrint: true })).toBe('print')
  })
  it('falls back to html on macOS, Linux, or without print()', () => {
    expect(pdfStrategy({ platform: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit', canPrint: true })).toBe('html')
    expect(pdfStrategy({ platform: 'Mozilla/5.0 (X11; Linux x86_64)', canPrint: true })).toBe('html')
    expect(pdfStrategy({ platform: win, canPrint: false })).toBe('html')
    expect(pdfStrategy({ platform: '', canPrint: true })).toBe('html')
  })
})

describe('renderHtmlPage with hostile content', () => {
  it('cannot run script from text, title, code, links or images', () => {
    const page = renderHtmlPage({
      title: '</title><script>alert(1)</script>',
      scope: 'thread',
      exportedAt: '2026-10-01T10:00:00.000Z',
      messages: [
        {
          role: 'assistant',
          text: [
            '<svg onload=alert(1)>',
            '[click](javascript:alert(1)) [data](data:text/html,<script>alert(1)</script>)',
            '![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=) ![y](javascript:alert(1))',
            '```html\n<script>alert(3)</script>\n```',
            '<a href="javascript:alert(4)">raw</a> <iframe src="x"></iframe>',
          ].join('\n\n'),
        },
      ],
    })
    expect(page).not.toMatch(/<script/i)
    expect(page).not.toMatch(/<(svg|iframe|img)/i)
    expect(page).not.toMatch(/<a [^>]*href="(javascript|data):/i)
    expect(page).not.toMatch(/<[^>]+\son\w+=/i)
    expect(page).toContain("default-src 'none'")
  })
})
