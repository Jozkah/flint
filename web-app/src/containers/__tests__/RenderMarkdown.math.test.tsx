import { render, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { RenderMarkdown } from '../RenderMarkdown'

vi.mock('@i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

Object.assign(navigator, { clipboard: { writeText: vi.fn() } })

afterEach(() => cleanup())

const html = (content: string) => {
  const { container } = render(<RenderMarkdown content={content} />)
  return container
}
const annotations = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('annotation[encoding="application/x-tex"]')).map(
    (a) => a.textContent
  )

describe('RenderMarkdown math', () => {
  it('renders $x^2$ inline', () => {
    const c = html('Area is $x^2$ here.')
    expect(c.querySelector('.katex')).toBeTruthy()
    expect(c.querySelector('.katex-display')).toBeNull()
    expect(annotations(c)).toEqual(['x^2'])
  })

  it('sets inline fractions at display size, and leaves other inline math alone', () => {
    const c = html('So $x = \\frac{-b}{2a}$ and \\(\\frac{1}{2}\\) but $y^2$.')
    expect(annotations(c)).toEqual([
      '\\displaystyle x = \\frac{-b}{2a}',
      '\\displaystyle \\frac{1}{2}',
      'y^2',
    ])
    expect(c.querySelector('.katex-display')).toBeNull()
  })

  it('renders $$...$$ as display math', () => {
    const c = html('Before\n\n$$\\sum_{i=1}^{n} i$$\n\nAfter')
    expect(c.querySelector('.katex-display')).toBeTruthy()
  })

  it('renders \\( \\) inline math', () => {
    const c = html('Value \\(a+b\\) done')
    expect(annotations(c)).toEqual(['a+b'])
    expect(c.querySelector('.katex-display')).toBeNull()
  })

  it('renders \\[ \\] display math', () => {
    const c = html('Text\n\n\\[\\int_0^1 x\\,dx\\]\n\nMore')
    expect(c.querySelector('.katex-display')).toBeTruthy()
  })

  it('renders the quadratic formula', () => {
    const c = html('$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$')
    expect(c.querySelector('.katex-display')).toBeTruthy()
    expect(c.querySelector('.katex-error')).toBeNull()
    expect(c.querySelector('.mfrac')).toBeTruthy()
    expect(c.querySelector('.sqrt')).toBeTruthy()
  })

  it('leaves currency like $5 and $6 as plain text', () => {
    const c = html('It costs $5 and $6 in total.')
    expect(c.querySelector('.katex')).toBeNull()
    expect(c.textContent).toContain('$5 and $6')
  })
})

describe('KaTeX assets are bundled', () => {
  const require = createRequire(import.meta.url)
  const cssPath = join(
    dirname(require.resolve('katex/package.json')),
    'dist',
    'katex.min.css'
  )

  it('imports the katex stylesheet from the package, not a URL', () => {
    const app = readFileSync(join(__dirname, '..', 'RenderMarkdown.tsx'), 'utf8')
    const css = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8')
    expect(app).toContain("import 'katex/dist/katex.min.css'")
    expect(css).toContain('katex/dist/katex.min.css')
  })

  it('references only relative font files that exist, no CDN', () => {
    expect(existsSync(cssPath)).toBe(true)
    const css = readFileSync(cssPath, 'utf8')
    expect(css).not.toMatch(/https?:\/\//)
    const urls = Array.from(css.matchAll(/url\(([^)]+)\)/g)).map((m) =>
      m[1].replace(/["']/g, '')
    )
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) {
      expect(u.startsWith('fonts/')).toBe(true)
      expect(existsSync(join(dirname(cssPath), u))).toBe(true)
    }
  })
})
