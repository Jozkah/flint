import { describe, it, expect } from 'vitest'
import {
  sanitizeInvalidJsonEscapes,
  repairToolArgs,
  recoverToolArgs,
} from '../toolCallRepair'

describe('sanitizeInvalidJsonEscapes', () => {
  it('re-escapes a Windows drive path with all-literal backslashes', () => {
    const raw = '{"path":"C:\\Users\\name\\file.txt"}'
    expect(JSON.parse(sanitizeInvalidJsonEscapes(raw))).toEqual({
      path: 'C:\\Users\\name\\file.txt',
    })
  })

  it('handles Program Files and Windows system folders', () => {
    const raw = '{"path":"C:\\Program Files\\Windows\\notepad.exe"}'
    expect(JSON.parse(sanitizeInvalidJsonEscapes(raw))).toEqual({
      path: 'C:\\Program Files\\Windows\\notepad.exe',
    })
  })

  it('re-escapes segments starting with JSON escape letters', () => {
    const raw = '{"path":"C:\\temp\\new\\report.txt"}'
    expect(JSON.parse(sanitizeInvalidJsonEscapes(raw))).toEqual({
      path: 'C:\\temp\\new\\report.txt',
    })
  })

  it('preserves genuine unicode escapes', () => {
    const raw = '{"path":"C:\\u0041\\dir"}'
    expect(JSON.parse(sanitizeInvalidJsonEscapes(raw))).toEqual({
      path: 'C:A\\dir',
    })
  })

  it('treats \\u not followed by hex as a literal backslash', () => {
    const raw = '{"path":"C:\\users\\bob"}'
    expect(JSON.parse(sanitizeInvalidJsonEscapes(raw))).toEqual({
      path: 'C:\\users\\bob',
    })
  })

  it('handles a trailing directory-separator backslash', () => {
    const raw = '{"path":"C:\\Users\\"}'
    expect(JSON.parse(sanitizeInvalidJsonEscapes(raw))).toEqual({
      path: 'C:\\Users\\',
    })
  })

  it('handles UNC paths (leading double backslash)', () => {
    const raw = '{"path":"\\\\server\\share\\file"}'
    expect(JSON.parse(sanitizeInvalidJsonEscapes(raw))).toEqual({
      path: '\\\\server\\share\\file',
    })
  })

  // Jozkah/jan#85: an escaped quote must not end the string, or every later
  // backslash in the value is left undoubled.
  it('keeps string tracking across an escaped quote', () => {
    const raw = '{"text":"say \\"hi\\" then C:\\Users\\x"}'
    expect(JSON.parse(sanitizeInvalidJsonEscapes(raw))).toEqual({
      text: 'say "hi" then C:\\Users\\x',
    })
    expect(repairToolArgs(raw)).toEqual({ text: 'say "hi" then C:\\Users\\x' })
  })

  it('leaves content outside string literals untouched', () => {
    const raw = '{"n":42,"ok":true}'
    expect(sanitizeInvalidJsonEscapes(raw)).toBe(raw)
  })
})

describe('repairToolArgs', () => {
  it('parses a broken Windows path', () => {
    expect(repairToolArgs('{"path":"D:\\repos\\jan\\file"}')).toEqual({
      path: 'D:\\repos\\jan\\file',
    })
  })

  it('returns valid JSON untouched, preserving intended escapes', () => {
    const raw = '{"text":"line1\\nline2\\ttab","q":"say \\"hi\\""}'
    expect(repairToolArgs(raw)).toEqual({
      text: 'line1\nline2\ttab',
      q: 'say "hi"',
    })
  })

  it('parses plain valid JSON', () => {
    expect(repairToolArgs('{"n":42}')).toEqual({ n: 42 })
  })

  it('returns null when unrepairable', () => {
    expect(repairToolArgs('{not json at all')).toBeNull()
  })

  it('returns null for non-object JSON', () => {
    expect(repairToolArgs('"just a string"')).toBeNull()
  })

  it('returns null for array JSON', () => {
    expect(repairToolArgs('[1,2,3]')).toBeNull()
  })
})

describe('recoverToolArgs', () => {
  it('recovers a trailing } on a read path (the package.json case)', () => {
    expect(
      recoverToolArgs('{"path":"C:\\repos\\jan\\package.json"}}'),
    ).toEqual({ path: 'C:\\repos\\jan\\package.json' })
  })

  it('recovers a trailing } on a nested-args shape (the where/git case)', () => {
    expect(
      recoverToolArgs('{"command":"where","args":["git"]}}'),
    ).toEqual({ command: 'where', args: ['git'] })
  })

  it('refuses concatenated empty objects', () => {
    expect(recoverToolArgs('{}{}')).toBeUndefined()
  })

  it('refuses two distinct concatenated objects', () => {
    expect(recoverToolArgs('{"a":1}{"b":2}')).toBeUndefined()
  })

  it('recovers a valid object with trailing whitespace', () => {
    expect(recoverToolArgs('{"a":1}   \n ')).toEqual({ a: 1 })
  })

  it('recovers a Windows path with bad backslash escapes', () => {
    expect(
      recoverToolArgs('{"path":"D:\\repos\\jan\\file.txt"}'),
    ).toEqual({ path: 'D:\\repos\\jan\\file.txt' })
  })

  it('recovers a trailing } after braces inside a quoted string', () => {
    expect(
      recoverToolArgs('{"content":"fn main() {}","path":"a.rs"}}'),
    ).toEqual({ content: 'fn main() {}', path: 'a.rs' })
  })

  it('recovers nested objects and arrays', () => {
    expect(
      recoverToolArgs('{"outer":{"inner":[1,2,3]},"n":5}'),
    ).toEqual({ outer: { inner: [1, 2, 3] }, n: 5 })
  })

  it('refuses truncated JSON', () => {
    expect(recoverToolArgs('{"path":"a.rs","co')).toBeUndefined()
  })

  it('refuses non-object JSON (primitives, arrays, null)', () => {
    expect(recoverToolArgs('"just a string"')).toBeUndefined()
    expect(recoverToolArgs('[1,2,3]')).toBeUndefined()
    expect(recoverToolArgs('null')).toBeUndefined()
    expect(recoverToolArgs('42')).toBeUndefined()
  })

  it('refuses text that is not JSON at all', () => {
    expect(recoverToolArgs('{not json at all')).toBeUndefined()
  })

  it('refuses an empty string', () => {
    expect(recoverToolArgs('')).toBeUndefined()
    expect(recoverToolArgs('   ')).toBeUndefined()
  })

  it('passes a plain object input through unchanged', () => {
    const obj = { path: 'a.rs' }
    expect(recoverToolArgs(obj)).toBe(obj)
  })

  it('refuses an array input', () => {
    expect(recoverToolArgs([1, 2])).toBeUndefined()
  })
})
