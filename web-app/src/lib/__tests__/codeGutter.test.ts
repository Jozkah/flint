import { describe, expect, it } from 'vitest'
import {
  blameForEdited,
  computeHunks,
  markersByLine,
  parseBlamePorcelain,
  peekLineOf,
  relativeTime,
  revertHunk,
  sandboxHunks,
} from '../codeGutter'

describe('change hunks', () => {
  it('finds nothing in an unchanged file', () => {
    expect(computeHunks('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('tells added, modified and deleted lines apart', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\n'
    const text = 'one\nTWO\nthree\nnew\nfour\n'
    expect(computeHunks(base, text)).toEqual([
      { kind: 'modified', start: 2, end: 2, oldLines: ['two'], newLines: ['TWO'] },
      { kind: 'added', start: 4, end: 4, oldLines: [], newLines: ['new'] },
      { kind: 'deleted', start: 6, end: 5, oldLines: ['five'], newLines: [] },
    ])
  })

  it('marks a deletion on the line above it', () => {
    const hunks = computeHunks('a\nb\nc\n', 'a\nc\n')
    expect(hunks[0]).toMatchObject({ kind: 'deleted', start: 2 })
    expect(markersByLine(hunks).get(1)?.kind).toBe('deleted')
  })

  it('treats a new file as all added, and CRLF like LF', () => {
    expect(computeHunks('', 'x\ny')).toEqual([
      { kind: 'added', start: 1, end: 2, oldLines: [], newLines: ['x', 'y'] },
    ])
    expect(computeHunks('a\r\nb\r\n', 'a\nb\n')).toEqual([])
  })

  it('reverts one hunk and leaves the others', () => {
    const base = 'one\ntwo\nthree\n'
    const text = 'zero\none\nTWO\nthree\n'
    const hunks = computeHunks(base, text)
    expect(hunks).toHaveLength(2)
    const back = revertHunk(text, hunks[1])
    expect(back).toBe('zero\none\ntwo\nthree\n')
    expect(revertHunk(back, computeHunks(base, back)[0])).toBe(base)
  })
})

describe('blame', () => {
  const sha1 = 'a'.repeat(40)
  const zero = '0'.repeat(40)
  const raw = [
    `${sha1} 1 1 2`,
    'author Ada',
    'author-mail <ada@x>',
    'author-time 1700000000',
    'summary Fix the parser',
    'filename a.ts',
    '\tline one',
    `${sha1} 2 2`,
    '\tline two',
    `${zero} 3 3 1`,
    'author Not Committed Yet',
    'author-time 1700000100',
    'summary Version of a.ts from a.ts',
    '\tline three',
    '',
  ].join('\n')

  it('attributes each final line to its commit', () => {
    const blame = parseBlamePorcelain(raw)
    expect(blame.lines[1]).toMatchObject({
      sha: sha1,
      author: 'Ada',
      time: 1700000000,
      summary: 'Fix the parser',
      uncommitted: false,
    })
    // A repeated commit carries no headers of its own.
    expect(blame.lines[2]).toBe(blame.lines[1])
    expect(blame.lines[3]?.uncommitted).toBe(true)
  })

  it('follows unsaved edits: changed lines are uncommitted, the rest shift', () => {
    const blame = parseBlamePorcelain(raw)
    const lines = blameForEdited(
      blame,
      'line one\nline two\nline three\n',
      'inserted\nline one\nline two\nline three\n'
    )
    expect(lines[1]?.uncommitted).toBe(true)
    expect(lines[2]?.sha).toBe(sha1)
    expect(lines[3]?.sha).toBe(sha1)
    expect(lines[4]?.uncommitted).toBe(true)
  })

  it('says how long ago, coarsely', () => {
    const now = 1_000_000_000
    expect(relativeTime(now - 14 * 86400, now)).toEqual({ value: -2, unit: 'week' })
    expect(relativeTime(now - 30, now)).toEqual({ value: 0, unit: 'second' })
  })
})

describe('sandbox hunks on the real file', () => {
  const real = 'a\nb\nc\nd\n'

  it('reads each difference as the sandbox’s change, on real lines', () => {
    const hunks = sandboxHunks(real, 'a\nB\nc\nd\nnew\n')
    expect(hunks).toEqual([
      { kind: 'modified', start: 2, end: 2, oldLines: ['b'], newLines: ['B'] },
      { kind: 'added', start: 4, end: 4, oldLines: [], newLines: ['new'] },
    ])
  })

  it('marks lines the sandbox dropped with a deletion on the first of them', () => {
    const [hunk] = sandboxHunks(real, 'a\nd\n')
    expect(hunk).toMatchObject({ kind: 'deleted', oldLines: ['b', 'c'], newLines: [] })
    expect(markersByLine([hunk]).has(2)).toBe(true)
  })

  it('finds nothing when the copies match', () => {
    expect(sandboxHunks(real, real)).toEqual([])
  })

  it('opens a peek under a change’s last line', () => {
    expect(peekLineOf({ kind: 'modified', start: 3, end: 5, oldLines: [], newLines: [] })).toBe(5)
    expect(peekLineOf({ kind: 'deleted', start: 4, end: 3, oldLines: ['x'], newLines: [] })).toBe(3)
  })
})
