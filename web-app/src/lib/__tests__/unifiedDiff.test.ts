import { describe, expect, it } from 'vitest'
import {
  diffLineCount,
  gutterWidth,
  MAX_RENDERED_DIFF_LINES,
  parseUnifiedDiff,
  truncateDiff,
} from '@/lib/unifiedDiff'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,6 +10,7 @@ export function thing() {
   const a = 1
-  const b = 2
+  const b = 3
+  const c = 4
   return a
 }`

describe('reading a diff', () => {
  const parsed = parseUnifiedDiff(DIFF)

  it('finds the hunk and keeps its header', () => {
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0].header).toBe('@@ -10,6 +10,7 @@')
  })

  it('keeps the enclosing scope git prints after the header', () => {
    expect(parsed.hunks[0].heading).toBe('export function thing() {')
  })

  it('drops the file headers, which belong to no hunk', () => {
    const text = parsed.hunks[0].lines.map((l) => l.content).join('\n')
    expect(text).not.toMatch(/diff --git|index |^--- |^\+\+\+ /m)
  })

  it('counts what changed', () => {
    expect(parsed.additions).toBe(2)
    expect(parsed.deletions).toBe(1)
  })
})

describe('the line numbers', () => {
  const lines = parseUnifiedDiff(DIFF).hunks[0].lines

  it('advance both sides on context', () => {
    expect(lines[0]).toMatchObject({ kind: 'context', oldNumber: 10, newNumber: 10 })
  })

  it('give a removed line an old number only', () => {
    const removed = lines.find((l) => l.kind === 'remove')!
    expect(removed.oldNumber).toBe(11)
    expect(removed.newNumber).toBeUndefined()
  })

  it('give an added line a new number only', () => {
    const added = lines.filter((l) => l.kind === 'add')
    expect(added[0]).toMatchObject({ newNumber: 11 })
    expect(added[0].oldNumber).toBeUndefined()
    expect(added[1].newNumber).toBe(12)
  })

  it('resume correctly after the change', () => {
    // The context line after two additions and one removal.
    const trailing = lines.filter((l) => l.kind === 'context')
    expect(trailing[1]).toMatchObject({ oldNumber: 12, newNumber: 13 })
  })

  it('strip the marker from the content', () => {
    expect(lines.find((l) => l.kind === 'add')!.content).toBe('  const b = 3')
  })
})

describe('the awkward cases', () => {
  it('handles the no-newline marker without consuming a line number', () => {
    const parsed = parseUnifiedDiff(
      '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c'
    )
    const meta = parsed.hunks[0].lines.find((l) => l.kind === 'meta')!
    expect(meta.content).toBe('No newline at end of file')
    expect(meta.oldNumber).toBeUndefined()
    expect(meta.newNumber).toBeUndefined()
    // The addition still numbers from where the removal left off.
    expect(parsed.hunks[0].lines.find((l) => l.kind === 'add')!.newNumber).toBe(2)
  })

  it('reads several hunks', () => {
    const parsed = parseUnifiedDiff(
      '@@ -1,1 +1,1 @@\n-a\n+b\n@@ -50,1 +50,1 @@\n-c\n+d'
    )
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[1].lines[0].oldNumber).toBe(50)
  })

  it('shows unparseable text rather than dropping it', () => {
    // A diff that does not match the grammar is still text worth reading.
    const parsed = parseUnifiedDiff('+added\n-removed\nplain')
    expect(parsed.unstructured).toBe(true)
    expect(parsed.hunks[0].lines).toHaveLength(3)
    expect(parsed.additions).toBe(1)
  })

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('').hunks).toEqual([])
  })
})

describe('keeping the window responsive', () => {
  const huge = [
    '@@ -1,5000 +1,5000 @@',
    ...Array.from({ length: 5000 }, (_, i) => `+line ${i}`),
  ].join('\n')

  it('cuts a very long diff off and says how much is missing', () => {
    const parsed = parseUnifiedDiff(huge)
    const { parsed: cut, omitted } = truncateDiff(parsed)
    expect(diffLineCount(cut)).toBe(MAX_RENDERED_DIFF_LINES)
    expect(omitted).toBe(5000 - MAX_RENDERED_DIFF_LINES)
  })

  it('leaves a normal diff alone', () => {
    const parsed = parseUnifiedDiff(DIFF)
    const { parsed: cut, omitted } = truncateDiff(parsed)
    expect(omitted).toBe(0)
    expect(cut).toBe(parsed)
  })
})

describe('the gutter', () => {
  it('is measured from the widest number, not guessed', () => {
    expect(gutterWidth(parseUnifiedDiff('@@ -1,1 +1,1 @@\n a'))).toBe(1)
    expect(gutterWidth(parseUnifiedDiff('@@ -1000,1 +1000,1 @@\n a'))).toBe(4)
  })
})
