import { describe, it, expect } from 'vitest'
import { detectEol, toLf, withEol } from '../lineEndings'
import { isNotFoundError } from '../fileErrors'

describe('lineEndings', () => {
  it('detects LF, CRLF, CR and a file with no break', () => {
    expect(detectEol('a\nb\n')).toBe('\n')
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n')
    expect(detectEol('a\rb\r')).toBe('\r')
    expect(detectEol('one line')).toBe('\n')
    expect(detectEol('')).toBe('\n')
  })

  it('takes the majority of a mixed file, CRLF on a tie', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(detectEol('a\nb\nc\r\n')).toBe('\n')
    expect(detectEol('a\r\nb\n')).toBe('\r\n')
  })

  it('normalizes to LF and round-trips a uniform file byte for byte', () => {
    for (const text of ['a\nb\n', 'a\r\nb\r\n', 'a\rb\r', 'x\r\n', 'min();\r\n']) {
      const eol = detectEol(text)
      expect(withEol(toLf(text), eol)).toBe(text)
    }
    expect(toLf('a\r\nb\rc\n')).toBe('a\nb\nc\n')
  })

  it('writes an edited buffer in the file style, even if typed text had other breaks', () => {
    expect(withEol('a\nB\n', '\r\n')).toBe('a\r\nB\r\n')
    expect(withEol('a\r\nB', '\n')).toBe('a\nB')
  })
})

describe('isNotFoundError', () => {
  it('recognizes missing files from the OS, the asset protocol and node', () => {
    expect(
      isNotFoundError(
        'C:\p\src\nope.ts is unreadable: The system cannot find the file specified. (os error 2)'
      )
    ).toBe(true)
    expect(isNotFoundError('No such file or directory (os error 2)')).toBe(true)
    expect(isNotFoundError('ENOENT: no such file')).toBe(true)
    expect(isNotFoundError('404')).toBe(true)
  })

  it('does not call a denied or broken read missing', () => {
    expect(isNotFoundError('Access is denied. (os error 5)')).toBe(false)
    expect(isNotFoundError('500')).toBe(false)
    expect(isNotFoundError('Failed to fetch')).toBe(false)
  })
})
