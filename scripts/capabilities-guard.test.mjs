import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// O02-023: capability scopes stay as narrow as the code needs.
const read = (rel) => readFileSync(new URL(`../src-tauri/capabilities/${rel}`, import.meta.url), 'utf8')

test('system-monitor-window has no http permission', () => {
  const cap = JSON.parse(read('system-monitor-window.json'))
  const ids = cap.permissions.map((p) => (typeof p === 'string' ? p : p.identifier))
  assert.ok(!ids.some((id) => id.startsWith('http:')), 'http permission found')
})

test('opener allow list has no 0.0.0.0', () => {
  const cap = JSON.parse(read('default.json'))
  const opener = cap.permissions.find((p) => typeof p === 'object' && p.identifier === 'opener:allow-open-url')
  assert.ok(opener, 'opener:allow-open-url missing')
  for (const entry of opener.allow) assert.ok(!entry.url.includes('0.0.0.0'), entry.url)
})
