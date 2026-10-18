import { describe, it, expect } from 'vitest'
import { changeCounts, changesFromToolCalls } from '../turnChanges'

describe('changesFromToolCalls', () => {
  it('sums writes and edits per file, skips failures and reads', () => {
    const files = changesFromToolCalls([
      { name: 'read', ok: true, args: { path: 'a.ts' } },
      { name: 'write', ok: true, args: { path: 'new.ts', content: 'a\nb\n' } },
      {
        name: 'edit',
        ok: true,
        args: { path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y\nz' }] },
      },
      { name: 'edit', ok: true, args: { path: 'a.ts', edits: [{ old_string: 'q', new_string: 'r' }] } },
      { name: 'write', ok: false, args: { path: 'bad.ts', content: 'zzz' } },
    ])
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ['new.ts', 2, 0],
      ['a.ts', 3, 2],
    ])
    expect(files[1].excerpt).toContain('-x')
    expect(files[1].excerpt).toContain('+y')
    expect(changeCounts(files)).toEqual({ fileCount: 2, additions: 5, deletions: 2 })
  })

  it('is empty for a turn that changed nothing', () => {
    expect(changesFromToolCalls([{ name: 'grep', ok: true, args: {} }])).toEqual([])
    expect(changesFromToolCalls(undefined)).toEqual([])
  })
})
