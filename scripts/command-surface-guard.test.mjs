import test from 'node:test'
import assert from 'node:assert/strict'
import { scanSource, newFindings } from './command-surface-guard.mjs'

test('flags a risky path parameter', () => {
  const src = `#[tauri::command]\npub async fn read_it(path: String) -> Result<(), String> { Ok(()) }`
  assert.deepEqual(scanSource(src), [{ fn: 'read_it', param: 'path' }])
})

test('flags several risky params and generics', () => {
  const src = `#[tauri::command]\npub fn export<R: Runtime>(app: AppHandle<R>, destination: String, root: String) {}`
  assert.deepEqual(
    scanSource(src).map((f) => f.param),
    ['destination', 'root']
  )
})

test('ipc-scope comment accepts the command', () => {
  const src = `// ipc-scope: resolved inside the data folder\n#[tauri::command]\npub fn read_it(path: String) {}`
  assert.deepEqual(scanSource(src), [])
})

test('safe parameter names pass, and non-commands are ignored', () => {
  const src = `#[tauri::command]\npub fn a(name: String) {}\nfn helper(path: String) {}`
  assert.deepEqual(scanSource(src), [])
})

test('only findings absent from the baseline are new', () => {
  assert.deepEqual(newFindings(['a::f::path', 'b::g::root'], ['a::f::path']), ['b::g::root'])
})
