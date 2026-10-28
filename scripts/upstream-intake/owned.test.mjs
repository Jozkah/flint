import test from 'node:test'
import assert from 'node:assert/strict'
import { OWNED, foreignKeys } from './owned.mjs'

test('owned keys pass, identity fields are foreign', () => {
  assert.deepEqual(foreignKeys({ decision: 'x', notes: 'y' }), [])
  assert.deepEqual(foreignKeys({ number: 1, title: 't' }), ['number', 'title'])
  assert.ok(foreignKeys([1]).length)
  assert.ok(OWNED.includes('implementationStatus'))
})
