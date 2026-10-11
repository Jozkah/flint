import { describe, expect, it } from 'vitest'
import type { TaskDiff, TaskDiffFile } from '../campaignApi'
import {
  fallbackDiff,
  kindOf,
  lineCounts,
  previewPatch,
  splitPath,
  totalsOf,
} from '../campaignDiff'

const file = (over: Partial<TaskDiffFile> = {}): TaskDiffFile => ({
  path: 'src/a.txt',
  status: 'modified',
  added: 0,
  removed: 0,
  binary: false,
  truncated: false,
  ...over,
})

describe('campaign diff formatting', () => {
  it('names the kind of change in plain words', () => {
    expect(kindOf(file({ status: 'added' }))).toBe('new')
    expect(kindOf(file({ status: 'modified' }))).toBe('edited')
    expect(kindOf(file({ status: 'deleted' }))).toBe('deleted')
    expect(kindOf(file({ status: 'renamed' }))).toBe('renamed')
  })

  it('writes counts as a +added and a minus removed pair', () => {
    expect(lineCounts(42, 7)).toBe('+42 −7')
  })

  it('totals from the files so the line always matches the list', () => {
    const diff: Pick<TaskDiff, 'files'> = {
      files: [file({ added: 30, removed: 2 }), file({ path: 'b', added: 12, removed: 5 })],
    }
    expect(totalsOf(diff)).toEqual({ files: 2, added: 42, removed: 7 })
  })

  it('falls back to the recorded names with no counts', () => {
    const d = fallbackDiff(['src/a.txt', 'b.ts'])
    expect(d.files.map((f) => f.path)).toEqual(['src/a.txt', 'b.ts'])
    expect(d.counted).toBe(false)
    expect(d.files.every((f) => f.patch == null)).toBe(true)
  })

  it('opens a long patch short and says how much is held back', () => {
    const patch = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join('\n')
    const p = previewPatch(patch, 40)
    expect(p.text.split('\n')).toHaveLength(40)
    expect(p.hidden).toBe(60)
    expect(previewPatch('+a\n+b', 40)).toEqual({ text: '+a\n+b', hidden: 0 })
  })

  it('splits a path into a quiet directory and a name', () => {
    expect(splitPath('src/lib/a.ts')).toEqual({ dir: 'src/lib/', name: 'a.ts' })
    expect(splitPath('a.ts')).toEqual({ dir: '', name: 'a.ts' })
    expect(splitPath('src\\a.ts')).toEqual({ dir: 'src\\', name: 'a.ts' })
  })
})
