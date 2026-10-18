import { describe, expect, it } from 'vitest'
import { flattenSnippet, richSnippet, snippetSpans } from '@/lib/richSnippet'

const text = (raw: string) => snippetSpans(raw).map((s) => s.text).join('')
const styled = (raw: string, style: string) =>
  snippetSpans(raw)
    .filter((s) => s[style as 'bold'])
    .map((s) => s.text)

describe('snippetSpans', () => {
  it('formats bold, italic, strike and inline code', () => {
    expect(styled('a **bold** b', 'bold')).toEqual(['bold'])
    expect(styled('a *it* and _it2_ b', 'italic')).toEqual(['it', 'it2'])
    expect(styled('a ~~gone~~ b', 'strike')).toEqual(['gone'])
    expect(styled('run `npm i` now', 'code')).toEqual(['npm i'])
    expect(text('a **bold** *it* `x` ~~s~~')).toBe('a bold it x s')
  })

  it('keeps link text and drops the target', () => {
    const spans = snippetSpans('see [the docs](https://x.y/z) and ![logo](a.png)')
    expect(spans.map((s) => s.text).join('')).toBe('see the docs and logo')
    expect(spans.find((s) => s.link)?.text).toBe('the docs')
  })

  it('flattens list bullets and headings to one line', () => {
    expect(text('* Capital of France: Paris * Capital of Japan: Tokyo * **Decisions:** None.')).toBe(
      'Capital of France: Paris · Capital of Japan: Tokyo · Decisions: None.'
    )
    expect(text('intro\n- one\n- two\n\n## Next steps\nmore')).toBe('intro · one · two Next steps more')
    expect(styled('## Next steps\nmore', 'bold')).toEqual(['Next steps'])
  })

  it('shows code fences as inline code', () => {
    const spans = snippetSpans('try\n```ts\nconst a = 1\n```\ndone')
    expect(spans.find((s) => s.code)?.text).toBe('const a = 1')
    expect(spans.map((s) => s.text).join('')).toBe('try const a = 1 done')
    // A fence cut off by the snippet window.
    expect(snippetSpans('…look ``` let x = 2').find((s) => s.code)?.text).toBe('let x = 2')
  })

  it('honours escapes and leaves snake_case and lone markers alone', () => {
    expect(text('a \\*not em\\* b')).toBe('a *not em* b')
    expect(text('use snake_case_name here')).toBe('use snake_case_name here')
    // A spaced lone `*` reads as a flattened bullet (the backend joins lines).
    expect(text('a * b')).toBe('a · b')
    expect(text('price *unclosed')).toBe('price *unclosed')
  })

  it('drops doubled markers cut off by the snippet window', () => {
    expect(text('…Facts:** the sky is blue')).toBe('…Facts: the sky is blue')
    expect(text('the **start of bold…')).toBe('the start of bold…')
    expect(text('not Sydney. ##…')).toBe('not Sydney.…')
    expect(text('Paris * …')).toBe('Paris…')
    expect(styled('use `capital…', 'code')).toEqual(['capital'])
    expect(text('use `capital…')).toBe('use capital…')
  })

  it('never keeps HTML tags or mention blocks', () => {
    const raw = 'hi <img src=x onerror="alert(1)"> <script>alert(2)</script> there'
    const out = text(raw)
    expect(out).not.toMatch(/<|onerror/)
    expect(out).toContain('hi')
    expect(
      text('ask <conversation-mention kind="chat" id="x">secret</conversation-mention> it')
    ).toBe('ask it')
  })

  it('copes with very long lines', () => {
    const long = '**' + 'a'.repeat(20000) + '** ' + '*b '.repeat(2000)
    const t0 = performance.now()
    const spans = snippetSpans(long)
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(spans[0].bold).toBe(true)
  })

  it('flattenSnippet collapses whitespace', () => {
    expect(flattenSnippet('a\n\n   b\tc')).toBe('a b c')
  })
})

describe('richSnippet', () => {
  it('marks a match inside bold and inside code', () => {
    const parts = richSnippet('the **Paris** trip uses `paris.js`', 'paris')
    const marks = parts.filter((p) => p.match)
    expect(marks.map((p) => p.text)).toEqual(['Paris', 'paris'])
    expect(marks[0].bold).toBe(true)
    expect(marks[1].code).toBe(true)
  })

  it('marks a match spanning a style change', () => {
    const parts = richSnippet('Key **Facts:** none', 'facts: no')
    const marks = parts.filter((p) => p.match)
    expect(marks.map((p) => p.text).join('')).toBe('Facts: no')
    expect(marks[0].bold).toBe(true)
    expect(marks[marks.length - 1].bold).toBeUndefined()
    expect(parts.map((p) => p.text).join('')).toBe('Key Facts: none')
  })

  it('keeps ellipses and marks nothing for an empty query', () => {
    const parts = richSnippet('…middle of **it**…', '')
    expect(parts.every((p) => !p.match)).toBe(true)
    expect(parts.map((p) => p.text).join('')).toBe('…middle of it…')
  })
})
