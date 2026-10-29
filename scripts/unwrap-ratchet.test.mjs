import assert from 'node:assert/strict'
import test from 'node:test'
import { compare, countSites } from './unwrap-ratchet.mjs'

test('counts production sites and stops at the first cfg(test)', () => {
  const src = [
    'fn a() { x.unwrap(); y.expect("b"); }',
    '// z.unwrap() in a comment',
    'fn c() { panic!("no"); }',
    '#[cfg(test)]',
    'mod tests { fn t() { q.unwrap(); } }',
  ].join('\r\n')
  assert.equal(countSites(src), 3)
})

test('unwrap_or and friends are not sites', () => {
  assert.equal(countSites('a.unwrap_or(1); b.unwrap_or_default(); c.expect_err("x");'), 0)
})

test('growth fails, shrinkage only hints', () => {
  const { grown, shrunk } = compare({ 'a.rs': 3, 'b.rs': 1, 'new.rs': 1 }, { 'a.rs': 2, 'b.rs': 4 })
  assert.deepEqual(grown.map((g) => g.file), ['a.rs', 'new.rs'])
  assert.deepEqual(shrunk.map((s) => s.file), ['b.rs'])
})
