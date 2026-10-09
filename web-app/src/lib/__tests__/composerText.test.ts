import { describe, expect, it } from 'vitest'
import { unescapeComposerMarkdown } from '../composerText'

describe('unescapeComposerMarkdown', () => {
  it('removes the escapes the serializer adds', () => {
    expect(unescapeComposerMarkdown('What is 17\\*23?')).toBe('What is 17*23?')
    expect(unescapeComposerMarkdown('snake\\_case \\# not a heading')).toBe(
      'snake_case # not a heading'
    )
  })

  it('decodes the entities written for < > &', () => {
    expect(unescapeComposerMarkdown('a &lt;b&gt; &amp; c')).toBe('a <b> & c')
    // A literal `&amp;` typed by the user is saved as `&amp;amp;`.
    expect(unescapeComposerMarkdown('AT&amp;amp;T')).toBe('AT&amp;T')
  })

  it('keeps a typed backslash and leaves other text alone', () => {
    // `\\` in the saved Markdown is one typed backslash.
    expect(unescapeComposerMarkdown('C:\\\\dir')).toBe('C:\\dir')
    // A backslash before a letter is not an escape.
    expect(unescapeComposerMarkdown('C:\\dir')).toBe('C:\\dir')
    expect(unescapeComposerMarkdown('**bold** and `code`')).toBe(
      '**bold** and `code`'
    )
  })
})
