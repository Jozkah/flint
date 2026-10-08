import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { REQUIRED_STACK_RESERVE, stackReserve } from './check-main-thread-stack.mjs'

/** A minimal PE32+ header with the given stack reserve. */
function pe(reserve) {
  const bytes = new Uint8Array(0x200)
  const view = new DataView(bytes.buffer)
  view.setUint32(0x3c, 0x80, true) // e_lfanew
  view.setUint32(0x80, 0x00004550, true) // "PE\0\0"
  view.setUint16(0x80 + 24, 0x20b, true) // PE32+
  view.setBigUint64(0x80 + 24 + 72, BigInt(reserve), true)
  return bytes
}

test('reads the stack reserve out of a PE32+ header', () => {
  assert.equal(stackReserve(pe(1024 * 1024)), 1024 * 1024)
  assert.equal(stackReserve(pe(REQUIRED_STACK_RESERVE)), REQUIRED_STACK_RESERVE)
})

test('refuses what is not a 64-bit PE file', () => {
  assert.throws(() => stackReserve(new Uint8Array(0x200)), /not a PE file/)
  const bytes = pe(1)
  new DataView(bytes.buffer).setUint16(0x80 + 24, 0x10b, true)
  assert.throws(() => stackReserve(bytes), /PE32\+/)
})

test('the build asks the linker for the stack and the release workflow checks it', async () => {
  const build = await readFile(new URL('../src-tauri/build.rs', import.meta.url), 'utf8')
  assert.match(build, /rustc-link-arg-bins=\/STACK:8388608/)
  const workflow = await readFile(new URL('../.github/workflows/flint-release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /check-main-thread-stack\.mjs/)
})
