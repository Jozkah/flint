import assert from 'node:assert/strict'
import test from 'node:test'
import { runChecks } from './pre-commit.mjs'

const ok = { ok: true, status: 0 }

test('lint is invoked without --fix', () => {
  const calls = []
  const code = runChecks({
    root: '/repo',
    platform: 'linux',
    exists: () => true,
    log: () => {},
    run: (command, args) => {
      calls.push([command, args])
      return ok
    },
  })
  assert.equal(code, 0)
  const lint = calls.find(([command]) => command === 'yarn')
  assert.deepEqual(lint[1], ['lint', '--quiet'])
})

test('failing lint returns its status and logs the fix hint', () => {
  const logs = []
  const code = runChecks({
    root: '/repo',
    platform: 'linux',
    exists: () => true,
    log: (m) => logs.push(m),
    run: (command) => (command === 'yarn' ? { ok: false, status: 3 } : ok),
  })
  assert.equal(code, 3)
  assert.match(logs.join('\n'), /yarn lint --fix/)
})

test('skips lint when node_modules missing', () => {
  const calls = []
  const code = runChecks({
    root: '/repo',
    platform: 'linux',
    exists: () => false,
    log: () => {},
    run: (command, args) => {
      calls.push([command, args])
      return ok
    },
  })
  assert.equal(code, 0)
  assert.ok(!calls.some(([command]) => command === 'yarn'))
})
