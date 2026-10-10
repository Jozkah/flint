import { describe, it, expect } from 'vitest'
import {
  extractFencedBlocks,
  findNamedBlock,
  parseFenceFilename,
  parseLeadingCommentFilename,
  resolveCodeBlockFileName,
  toDownloadFileName,
} from '../codeBlockFilename'

describe('parseFenceFilename', () => {
  it('reads a bare name, a bracketed name and key=value forms', () => {
    expect(parseFenceFilename('styles.css')).toBe('styles.css')
    expect(parseFenceFilename('[js/main.js]')).toBe('js/main.js')
    expect(parseFenceFilename('title="data/content.js" {1,3}')).toBe(
      'data/content.js'
    )
    expect(parseFenceFilename("filename='a.py'")).toBe('a.py')
  })

  it('ignores info that is not a filename', () => {
    expect(parseFenceFilename('')).toBeNull()
    expect(parseFenceFilename('showLineNumbers')).toBeNull()
    expect(parseFenceFilename('{1,3}')).toBeNull()
  })
})

describe('parseLeadingCommentFilename', () => {
  it('reads the name from the first-line comment', () => {
    expect(parseLeadingCommentFilename('// src/main.js\nconsole.log(1)')).toBe(
      'src/main.js'
    )
    expect(parseLeadingCommentFilename('# File: app.py\nprint(1)')).toBe(
      'app.py'
    )
    expect(parseLeadingCommentFilename('/* styles.css */\na{}')).toBe(
      'styles.css'
    )
  })

  it('does not take prose or code', () => {
    expect(parseLeadingCommentFilename('// run the thing\nx()')).toBeNull()
    expect(parseLeadingCommentFilename('const a = 1')).toBeNull()
  })
})

describe('resolveCodeBlockFileName', () => {
  it('prefers the fence over a comment', () => {
    expect(
      resolveCodeBlockFileName({
        language: 'js',
        meta: 'a.js',
        code: '// b.js\n',
      })
    ).toBe('a.js')
  })

  it('refuses a guessed name that disagrees with the language', () => {
    expect(
      resolveCodeBlockFileName({
        language: 'python',
        meta: '',
        code: '# see example.com\n',
      })
    ).toBeNull()
  })
})

describe('toDownloadFileName', () => {
  it('keeps the basename and strips illegal characters', () => {
    expect(toDownloadFileName('js/main.js')).toBe('main.js')
    expect(toDownloadFileName('a:b?.txt')).toBe('a b .txt')
    expect(toDownloadFileName('..')).toBeNull()
  })
})

describe('findNamedBlock', () => {
  const md = [
    'Here is the page.',
    '',
    '```html index.html',
    '<h1>Hi</h1>',
    '```',
    '',
    '```css',
    '/* styles.css */',
    'h1 { color: red; }',
    '```',
    '',
    '```js',
    'console.log(1)',
    '```',
  ].join('\n')

  it('extracts every closed fence', () => {
    expect(extractFencedBlocks(md).map((b) => b.language)).toEqual([
      'html',
      'css',
      'js',
    ])
  })

  it('finds the name from the fence, matching rendered text ignoring whitespace', () => {
    expect(findNamedBlock(md, '<h1>Hi</h1>')).toEqual({
      fileName: 'index.html',
      code: '<h1>Hi</h1>',
    })
  })

  it('finds the name from a leading comment', () => {
    const rendered = '/* styles.css */h1 { color: red; }'
    expect(findNamedBlock(md, rendered)?.fileName).toBe('styles.css')
  })

  it('returns null for a block that names nothing', () => {
    expect(findNamedBlock(md, 'console.log(1)')).toBeNull()
  })
})
