import { describe, expect, it } from 'vitest'
import {
  buildPatch,
  canApply,
  capRows,
  diffRows,
  dirtyOverlap,
  gutterNumber,
  preflight,
  ROWS_PAGE,
  splitPatch,
  summarize,
  unquotePath,
  type ApplyPreview,
} from '../applyReview'

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ export function a()
 one
-two
+TWO
+three
 four
@@ -10,2 +11,2 @@
 ten
-eleven
+ELEVEN
`
const ADDED = `diff --git a/new.md b/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# Title
+body
\\ No newline at end of file
`
const DELETED = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-too
`
const RENAMED = `diff --git a/lib/x.ts b/lib/y.ts
similarity index 90%
rename from lib/x.ts
rename to lib/y.ts
index 5555555..6666666 100644
--- a/lib/x.ts
+++ b/lib/y.ts
@@ -1 +1 @@
-x
+y
`
const BINARY = `diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000000000000000000000000000000000000..7777777777777777777777777777777777777777
GIT binary patch
literal 5
McmZ?wbaMbB0Dk}

literal 0
HcmV?d00001

`
const CRLF = 'diff --git a/w.bat b/w.bat\r\nindex 8..9 100644\r\n--- a/w.bat\r\n+++ b/w.bat\r\n@@ -1,2 +1,2 @@\r\n echo\r\n-old\r\n+new\r\n'

const PATCH = MODIFIED + ADDED + DELETED + RENAMED + BINARY

describe('splitPatch', () => {
  const files = splitPatch(PATCH)

  it('finds one entry per file with its status', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['new.md', 'added'],
      ['old.txt', 'deleted'],
      ['lib/y.ts', 'renamed'],
      ['logo.png', 'added'],
    ])
    expect(files[3].oldPath).toBe('lib/x.ts')
  })

  it('counts lines per file across hunks', () => {
    expect(files[0]).toMatchObject({ additions: 3, deletions: 2 })
    expect(files[0].diff.hunks).toHaveLength(2)
    expect(files[2]).toMatchObject({ additions: 0, deletions: 2 })
  })

  it('keeps the no-newline note as a meta row without counting it', () => {
    expect(files[1]).toMatchObject({ additions: 2, deletions: 0 })
    expect(diffRows(files[1].diff).at(-1)).toMatchObject({ kind: 'meta' })
  })

  it('marks binary files and shows no content for them', () => {
    expect(files[4]).toMatchObject({ binary: true, additions: 0, deletions: 0 })
    expect(diffRows(files[4].diff)).toEqual([])
  })

  it('reads CRLF patches without carriage returns in the display', () => {
    const [f] = splitPatch(CRLF)
    expect(f).toMatchObject({ path: 'w.bat', status: 'modified', additions: 1, deletions: 1 })
    expect(diffRows(f.diff).every((r) => !r.text.includes('\r'))).toBe(true)
    expect(f.raw).toBe(CRLF)
  })

  it('reads quoted paths', () => {
    expect(unquotePath('"a\\tb"')).toBe('a\tb')
    expect(unquotePath('"caf\\303\\251.txt"')).toBe('café.txt')
    const [f] = splitPatch('diff --git "a/sp ace.txt" "b/sp ace.txt"\n--- "a/sp ace.txt"\n+++ "b/sp ace.txt"\n@@ -1 +1 @@\n-a\n+b\n')
    expect(f.path).toBe('sp ace.txt')
  })

  it('returns nothing for an empty patch', () => {
    expect(splitPatch('')).toEqual([])
  })
})

describe('summarize and buildPatch', () => {
  const files = splitPatch(PATCH)

  it('totals files and lines', () => {
    expect(summarize(files)).toEqual({ fileCount: 5, additions: 6, deletions: 5 })
  })

  it('rebuilds the whole patch byte for byte', () => {
    expect(buildPatch(files, new Set(files.map((f) => f.path)))).toBe(PATCH)
  })

  it('builds a patch of only the selected files', () => {
    const out = buildPatch(files, new Set(['new.md', 'lib/y.ts']))
    expect(out).toBe(ADDED + RENAMED)
    expect(splitPatch(out).map((f) => f.path)).toEqual(['new.md', 'lib/y.ts'])
  })
})

describe('preflight', () => {
  const files = splitPatch(PATCH)
  const all = new Set(files.map((f) => f.path))
  const base: ApplyPreview = { patch: PATCH, target: 'C:/p', clean: true, files: [], dirty: [] }

  it('is checking until the dry run answers', () => {
    expect(preflight(null, all)).toEqual({ state: 'checking' })
    expect(canApply(preflight(null, all))).toBe(false)
  })

  it('applies cleanly', () => {
    expect(canApply(preflight(base, all))).toBe(true)
  })

  it('lists the selected conflicting files and disables Apply', () => {
    const p: ApplyPreview = {
      ...base,
      clean: false,
      files: [
        { path: 'src/a.ts', ok: false, reason: 'error: patch failed: src/a.ts:1' },
        { path: 'new.md', ok: true },
      ],
    }
    const r = preflight(p, all)
    expect(r).toEqual({ state: 'conflict', conflicts: [{ path: 'src/a.ts', reason: 'error: patch failed: src/a.ts:1' }] })
    expect(canApply(r)).toBe(false)
    // Leaving the conflicting file out makes the rest applicable.
    expect(canApply(preflight(p, new Set(['new.md'])))).toBe(true)
  })

  it('cannot apply nothing, nor after the check failed', () => {
    expect(preflight(base, new Set())).toEqual({ state: 'nothing' })
    expect(canApply(preflight(base, all, 'folder gone'))).toBe(false)
  })

  it('names uncommitted edits only among the selected files, renames by either path', () => {
    const p = { ...base, dirty: ['src/a.ts', 'lib/x.ts', 'other.txt'] }
    expect(dirtyOverlap(p, files, all)).toEqual(['src/a.ts', 'lib/x.ts'])
    expect(dirtyOverlap(p, files, new Set(['new.md']))).toEqual([])
  })
})

describe('large diffs', () => {
  it('caps the rendered rows and reports how many are hidden', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join('\n')
    const [f] = splitPatch(`diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,5000 @@\n${body}\n`)
    const rows = diffRows(f.diff)
    expect(rows).toHaveLength(5001)
    const { shown, hidden } = capRows(rows, ROWS_PAGE)
    expect(shown).toHaveLength(ROWS_PAGE)
    expect(hidden).toBe(5001 - ROWS_PAGE)
    expect(capRows(rows, 10_000).hidden).toBe(0)
  })
})

describe('gutterNumber', () => {
  it('shows one number per row: new for context and additions, old for removals, none for hunks', () => {
    const rows = diffRows(splitPatch(MODIFIED)[0].diff)
    expect(rows.map(gutterNumber).slice(0, 6)).toEqual([undefined, 1, 2, 2, 3, 4])
  })
})
