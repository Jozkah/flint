import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compare, measure } from './check-bundle-size.mjs'

test('growth within the allowance passes, beyond it fails', () => {
  const budget = { allowance: 0.1, metrics: { entryJs: 1000, totalJs: 1000 } }
  const rows = compare({ entryJs: 1100, totalJs: 1101 }, budget)
  assert.equal(rows.find((r) => r.key === 'entryJs').over, false)
  assert.equal(rows.find((r) => r.key === 'totalJs').over, true)
})

test('shrinking never fails', () => {
  const rows = compare({ entryJs: 10 }, { allowance: 0.1, metrics: { entryJs: 1000 } })
  assert.equal(rows[0].over, false)
})

test('measure counts the entry script separately from all JS and CSS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-size-'))
  try {
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<script type="module" src="/assets/index-a.js"></script>')
    writeFileSync(join(dir, 'assets', 'index-a.js'), 'console.log(1)'.repeat(50))
    writeFileSync(join(dir, 'assets', 'route-b.js'), 'console.log(2)'.repeat(50))
    writeFileSync(join(dir, 'assets', 'app.css'), 'a{color:red}'.repeat(50))
    const m = measure(dir)
    assert.ok(m.entryJs > 0)
    assert.ok(m.totalJs > m.entryJs)
    assert.ok(m.totalCss > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
