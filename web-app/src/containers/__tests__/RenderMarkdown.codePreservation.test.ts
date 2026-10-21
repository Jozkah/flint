import { describe, it, expect } from 'vitest'
import { normalizeLatex } from '../RenderMarkdown'

describe('normalizeLatex keeps code verbatim', () => {
  it.each([
    ['tilde fence', '~~~sh\nprintf "$100"\n\\(literal\\)\na**b**c\n~~~'],
    [
      'long backtick fence with an inner fence',
      '````md\n```sh\n$100\n```\n\\(literal\\)\na**b**c\n````',
    ],
    ['unfinished backtick fence', '```sh\nprintf "$100"\n\\(literal\\)\na**b**c'],
    ['unfinished tilde fence', '~~~sh\nprintf "$100"\n\\(literal\\)\na**b**c'],
    ['longer closing fence', '~~~sh\n$100\n~~~~\n'],
    ['multi-backtick code span', 'Use ``literal ` $100 \\(x\\) a**b**c`` here.'],
    ['multiline code span', 'Use `$100\n\\(x\\)` here.'],
    ['ordinary backtick fence', '```sh\n$100\n\\(x\\)\n```'],
    ['ordinary inline code', 'Use `$100 \\(x\\)` here.'],
  ])('keeps %s unchanged', (_, content) => {
    expect(normalizeLatex(content)).toBe(content)
  })

  it('still normalizes math outside a code fence', () => {
    expect(normalizeLatex('~~~sh\n$100\n~~~\n\\(x\\) costs $200')).toBe(
      '~~~sh\n$100\n~~~\n$x$ costs \\$200'
    )
  })
})
