import { describe, it, expect } from 'vitest'
import { resolveFileFilter, unmatchedNote } from './retrieval'

const files = [
  { id: 'f1', name: 'Report.PDF', path: 'C:\\docs\\Report.PDF' },
  { id: 'f2', name: 'notes.txt', path: '/home/u/notes.txt' },
  { id: 'f3', path: '/tmp/only-path.md' },
]

describe('resolveFileFilter', () => {
  it('has no filter when none was requested', () => {
    expect(resolveFileFilter(undefined, files)).toEqual({ fileIds: undefined, unmatched: [] })
    expect(resolveFileFilter([], files)).toEqual({ fileIds: undefined, unmatched: [] })
    expect(resolveFileFilter(['  '], files)).toEqual({ fileIds: undefined, unmatched: [] })
  })

  it('matches by id first', () => {
    expect(resolveFileFilter(['f2'], files)).toEqual({ fileIds: ['f2'], unmatched: [] })
  })

  it('matches by name, case-insensitively, and by basename of a path', () => {
    expect(resolveFileFilter(['report.pdf'], files).fileIds).toEqual(['f1'])
    expect(resolveFileFilter(['/some/where/NOTES.txt'], files).fileIds).toEqual(['f2'])
    expect(resolveFileFilter(['only-path.md'], files).fileIds).toEqual(['f3'])
  })

  it('prefers an id over a name that happens to equal another file', () => {
    const tricky = [
      { id: 'a', name: 'b' },
      { id: 'b', name: 'other' },
    ]
    expect(resolveFileFilter(['b'], tricky).fileIds).toEqual(['b'])
  })

  it('dedupes and keeps the matched ones, reporting the rest', () => {
    const got = resolveFileFilter(['f1', 'report.pdf', 'missing.doc'], files)
    expect(got).toEqual({ fileIds: ['f1'], unmatched: ['missing.doc'] })
  })

  it('drops the filter when nothing matches', () => {
    const got = resolveFileFilter(['nope.pdf'], files)
    expect(got).toEqual({ fileIds: undefined, unmatched: ['nope.pdf'] })
  })
})

describe('unmatchedNote', () => {
  it('says nothing when everything matched', () => {
    expect(unmatchedNote({ fileIds: ['f1'], unmatched: [] })).toBeUndefined()
  })
  it('says what happened when the filter was dropped or narrowed', () => {
    expect(unmatchedNote({ fileIds: undefined, unmatched: ['x'] })).toContain('searched all attached files')
    expect(unmatchedNote({ fileIds: ['f1'], unmatched: ['x'] })).toContain('searched the others')
  })
})
