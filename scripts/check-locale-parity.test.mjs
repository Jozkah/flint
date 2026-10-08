import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { byBaseKey, checkLocales, flatten, placeholders, toBaseline } from './check-locale-parity.mjs'

function locales(files) {
  const root = mkdtempSync(join(tmpdir(), 'locale-parity-'))
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

test('flattens nested files and groups plural forms', () => {
  const flat = flatten({ a: { b: 'x', c: { d: 'y' } }, n_one: '{{count}} item', n_other: '{{count}} items' })
  assert.deepEqual([...flat.keys()], ['a.b', 'a.c.d', 'n_one', 'n_other'])
  assert.deepEqual([...byBaseKey(flat).keys()], ['a.b', 'a.c.d', 'n'])
})

test('reads placeholders from any form, with formats', () => {
  assert.deepEqual(placeholders(['Hi {{name}}', '{{ count , number }} left']), ['count', 'name'])
  assert.deepEqual(placeholders(['nothing']), [])
})

test('a complete locale passes, even with different plural forms', () => {
  const root = locales({
    'en/a.json': { title: 'T', n_one: '{{count}} item', n_other: '{{count}} items' },
    'ja/a.json': { title: 'タ', n_other: '{{count}}個' },
  })
  try {
    const r = checkLocales(root)
    assert.deepEqual(r.errors, [])
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('missing namespaces and keys are errors, relaxed by the flags', () => {
  const root = locales({
    'en/a.json': { one: '1', two: '2' },
    'en/b.json': { x: 'x' },
    'de/a.json': { one: 'eins' },
  })
  try {
    const strict = checkLocales(root)
    assert.equal(strict.errors.length, 2)
    assert.match(strict.errors.join('\n'), /missing namespace file b\.json/)
    assert.match(strict.errors.join('\n'), /de\/a\.json: 1 missing key\(s\): two/)

    const some = checkLocales(root, { allowMissingNamespaces: true })
    assert.equal(some.errors.length, 1)
    assert.match(some.errors[0], /missing key/)

    const lenient = checkLocales(root, { lenient: true })
    assert.deepEqual(lenient.errors, [])
    assert.equal(lenient.warnings.length, 2)
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('malformed JSON, placeholder drift and keys English lacks are errors in lenient mode', () => {
  const root = locales({
    'en/a.json': { hello: 'Hello {{name}}', gone: 'x' },
    'fr/a.json': { hello: 'Bonjour {{nom}}', stale: 'old' },
    'es/a.json': '{ not json',
  })
  try {
    const lenient = checkLocales(root, { lenient: true })
    const text = lenient.errors.join('\n')
    assert.match(text, /es\/a\.json: not valid JSON/)
    assert.match(text, /fr\/a\.json: 1 placeholder mismatch/)
    assert.match(text, /fr\/a\.json: 1 key\(s\) not in en: stale/)
    // The same keys are only a warning in strict mode (the missing key is the error).
    const strict = checkLocales(root)
    assert.ok(strict.warnings.some((w) => /not in en: stale/.test(w)))
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('a baseline excuses known debt but not new findings', () => {
  const root = locales({
    'en/a.json': { keep: 'k' },
    'fr/a.json': { keep: 'k', old: 'o', fresh: 'f' },
  })
  try {
    const baseline = { 'fr/a.json': { extra: ['old'] } }
    const r = checkLocales(root, { lenient: true, baseline })
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /not in en: fresh/)
    assert.ok(r.warnings.some((w) => /1 key\(s\) not in en \(in the baseline\)/.test(w)))
    const prefixed = checkLocales(root, { lenient: true, baseline: { 'fr/a.json': { extra: ['old', 'fresh'] } } })
    assert.deepEqual(prefixed.errors, [])
  } finally {
    rmSync(root, { recursive: true })
  }
})

test('writes a baseline that compresses whole subtrees', () => {
  const found = { 'es/s.json': { extra: ['remote.a', 'remote.b', 'remote.c', 'remote.d', 'solo'] } }
  assert.deepEqual(toBaseline(found), { 'es/s.json': { extra: ['remote.*', 'solo'] } })
  const root = locales({ 'en/s.json': { k: 'k' }, 'es/s.json': { k: 'k', remote: { a: '1', b: '2', c: '3', d: '4' } } })
  try {
    const r = checkLocales(root, { lenient: true, baseline: toBaseline(checkLocales(root, { lenient: true }).found) })
    assert.deepEqual(r.errors, [])
  } finally {
    rmSync(root, { recursive: true })
  }
})
