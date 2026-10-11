import { describe, it, expect } from 'vitest'
import { displayNameOf, extensionOf } from '../displayName'
import { injectFilesIntoPrompt } from '../fileMetadata'

describe('displayNameOf', () => {
  it('strips Windows directories', () => {
    expect(displayNameOf('C:\\Users\\x\\a b.png')).toBe('a b.png')
  })
  it('decodes file URLs', () => {
    expect(displayNameOf('file:///C:/Users/x/a%20b.png')).toBe('a b.png')
    expect(displayNameOf('file:///home/x/r%C3%A9sum%C3%A9.pdf')).toBe('résumé.pdf')
  })
  it('handles UNC and POSIX paths', () => {
    expect(displayNameOf('\\\\server\\share\\f.docx')).toBe('f.docx')
    expect(displayNameOf('/home/x/notes.md')).toBe('notes.md')
    expect(displayNameOf('/home/x/dir/')).toBe('dir')
  })
  it('names data and blob URLs without dumping them', () => {
    expect(displayNameOf('data:image/png;base64,AAAA')).toBe('image.png')
    expect(displayNameOf('data:application/octet-stream;base64,AAAA')).toBe('file')
    expect(displayNameOf('blob:http://localhost/1234-5678')).toBe('file')
  })
  it('drops query strings and fragments of URLs only', () => {
    expect(displayNameOf('https://h/p/a.png?x=1#y')).toBe('a.png')
    expect(displayNameOf('C:\\x\\what#1.txt')).toBe('what#1.txt')
  })
  it('keeps no-extension names and dotfiles', () => {
    expect(displayNameOf('/a/b/Makefile')).toBe('Makefile')
    expect(displayNameOf('/a/b/.env')).toBe('.env')
    expect(extensionOf('/a/b/.env')).toBe('')
    expect(extensionOf('C:\\a\\Report.PDF')).toBe('pdf')
  })
  it('survives a malformed escape and empty input', () => {
    expect(displayNameOf('file:///a/100%.txt')).toBe('100%.txt')
    expect(displayNameOf('')).toBe('')
  })
  it('middle-truncates long names keeping the extension', () => {
    const out = displayNameOf(
      '/x/quarterly-financial-report-final-version-2.pdf',
      24
    )
    expect(out.length).toBeLessThanOrEqual(24)
    expect(out.endsWith('.pdf')).toBe(true)
    expect(out).toContain('…')
  })
  it('leaves what is sent to the model unchanged', () => {
    const sent = injectFilesIntoPrompt('hi', [
      { id: 'f1', name: 'file:///C:/Users/x/a%20b.png', type: 'png' },
    ])
    expect(sent).toContain('name: file:///C:/Users/x/a%20b.png')
  })
})
