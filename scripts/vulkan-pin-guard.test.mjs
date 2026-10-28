// The engine toolchain action runs an installer and adds an apt source as
// root. Both must be pinned and verified, never fetched as "latest".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const action = fs.readFileSync(
  path.resolve(here, '..', '.github', 'actions', 'setup-engine-toolchain', 'action.yml'),
  'utf8'
)

test('the Vulkan SDK is never fetched as latest', () => {
  assert.ok(!action.includes('/latest/'), 'action.yml downloads a moving latest SDK')
})

test('the Windows installer hash is checked before it runs', () => {
  assert.ok(action.includes('sha256sum -c'), 'action.yml does not verify the installer')
  assert.match(action, /vulkan-sdk-sha256-windows:[\s\S]*?default: '[0-9a-f]{64}'/)
  assert.ok(action.indexOf('sha256sum -c') < action.indexOf('--accept-licenses'))
})

test('the apt signing key is fingerprint-checked and scoped to its source', () => {
  assert.ok(action.includes('signed-by='), 'apt key is not scoped with signed-by')
  assert.ok(!action.includes('trusted.gpg.d'), 'apt key is trusted globally')
  assert.match(action, /03F5D621A3710FA95A93D89BAA8452080E383F7E/)
})
