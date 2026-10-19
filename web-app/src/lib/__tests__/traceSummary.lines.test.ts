import { describe, expect, it } from 'vitest'
import { editLineCounts, summarizeTrace } from '../traceSummary'

describe('editLineCounts line endings', () => {
  it('does not count a CRLF line as changed against the same LF line', () => {
    expect(editLineCounts('a\r\nb\r\nc', 'a\nb\nc\nd')).toEqual({ added: 1, removed: 0 })
    expect(editLineCounts('a\nb\nc', 'a\r\nb\r\nc\r\nd\r\n')).toEqual({ added: 1, removed: 0 })
  })

  it('counts a real change the same with either ending', () => {
    expect(editLineCounts('a\r\nb', 'a\r\nx')).toEqual({ added: 1, removed: 1 })
  })
})

describe('summarizeTrace edit counts are stable across rebuilds', () => {
  it('gives the same totals when the same parts are summarized again', () => {
    const parts = [
      {
        type: 'tool-edit',
        state: 'output-available',
        input: { path: 'f.ts', edits: [{ old_string: 'a\nb', new_string: 'a\nb\nc' }] },
      },
    ]
    const first = summarizeTrace(parts)
    const second = summarizeTrace(parts)
    expect(first.added).toBe(1)
    expect(second.added).toBe(first.added)
    expect(second.removed).toBe(first.removed)
  })
})
