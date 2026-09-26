import { describe, expect, it } from 'vitest'
import { findFocusedRow } from '@/lib/coworkDiffs'

describe('Open diff finds the file in Changes', () => {
  const ids = ['git:src/a.ts', 'git:lib/b.ts', 'sandbox:out/c.ts']

  it('matches a path exactly, in either list', () => {
    expect(findFocusedRow(ids, 'src/a.ts')).toBe('git:src/a.ts')
    expect(findFocusedRow(ids, 'out/c.ts')).toBe('sandbox:out/c.ts')
  })

  it('matches a tool\u2019s absolute path to Git\u2019s relative one', () => {
    expect(findFocusedRow(ids, 'C:\\work\\repo\\lib\\b.ts')).toBe('git:lib/b.ts')
  })

  it('finds nothing rather than a wrong file', () => {
    expect(findFocusedRow(ids, 'src/ab.ts')).toBeNull()
    expect(findFocusedRow(ids, 'b.ts.bak')).toBeNull()
  })
})
