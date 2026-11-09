import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compare, LARGE_LINES, lineCount, scan, stem } from './untested-ui-ratchet.mjs'

const lines = (n) => Array.from({ length: n }, (_, i) => `const a${i} = ${i}`).join('\n') + '\n'

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'untested-ui-'))
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return root
}

test('stem strips the test suffix and the extension', () => {
  assert.equal(stem('a/b/Foo.tsx'), 'Foo')
  assert.equal(stem('Foo.test.tsx'), 'Foo')
  assert.equal(stem('useBar.spec.ts'), 'useBar')
  assert.equal(lineCount('a\r\nb\n'), 2)
})

test('only large files without a test named after them are reported', () => {
  const root = tree({
    'web-app/src/Big.tsx': lines(LARGE_LINES),
    'web-app/src/Tested.tsx': lines(LARGE_LINES + 5),
    'web-app/src/deep/__tests__/Tested.test.tsx': 'x\n',
    'web-app/src/Small.tsx': lines(LARGE_LINES - 1),
    'web-app/src/routeTree.gen.ts': lines(LARGE_LINES * 2),
    'web-app/src/dev/seed.ts': lines(LARGE_LINES * 2),
    'web-app/src/__tests__/Huge.test.tsx': lines(LARGE_LINES * 2),
  })
  try {
    assert.deepEqual(scan(root), { 'web-app/src/Big.tsx': LARGE_LINES })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new file or one grown past the allowance fails; paid-down debt only hints', () => {
  const baseline = { 'a.tsx': 1000, 'b.tsx': 1000, 'gone.tsx': 900 }
  const found = { 'a.tsx': 1100, 'b.tsx': 1101, 'c.tsx': 850 }
  const { added, grown, stale } = compare(found, baseline)
  assert.deepEqual(added, [{ file: 'c.tsx', lines: 850 }])
  assert.deepEqual(grown, [{ file: 'b.tsx', was: 1000, lines: 1101 }])
  assert.deepEqual(stale, [{ file: 'gone.tsx', was: 900, lines: 0 }])
})

test('the committed baseline matches the tree', () => {
  const root = join(import.meta.dirname, '..')
  const baseline = JSON.parse(readFileSync(join(import.meta.dirname, 'untested-ui-baseline.json'), 'utf8'))
  const { added, grown } = compare(scan(root), baseline)
  assert.deepEqual([...added, ...grown], [])
})
