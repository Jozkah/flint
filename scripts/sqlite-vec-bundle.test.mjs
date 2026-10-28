import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { pickSqliteVecLibrary, sqliteVecLibName } from './download-bin-install.mjs'

const root = path.resolve(import.meta.dirname, '..')

// download-bin writes resources/bin/<sqliteVecLibName>; each desktop bundle
// must list that exact path or the installer ships without sqlite-vec.
for (const [conf, platform] of [
  ['tauri.linux.conf.json', 'linux'],
  ['tauri.windows.conf.json', 'win32'],
  ['tauri.macos.conf.json', 'darwin'],
]) {
  test(`${conf} bundles the sqlite-vec file download-bin produces`, () => {
    const json = JSON.parse(readFileSync(path.join(root, 'src-tauri', conf), 'utf8'))
    assert.ok(
      json.bundle.resources.includes(`resources/bin/${sqliteVecLibName(platform)}`),
      `${conf} resources: ${json.bundle.resources.join(', ')}`
    )
  })
}

test('the CI stub script creates the bundled sqlite-vec file', () => {
  const stub = readFileSync(path.join(root, 'scripts/stub-tauri-resources.sh'), 'utf8')
  assert.match(stub, /sqlite-vec\.\$\{LIB##\*\.\}/)
})

test('picks vec0 for the platform, not the first library in the folder (H02-006)', () => {
  const files = [
    '/x/libbun-helper.so',
    '/x/sqlite-vec/libother.so',
    '/x/sqlite-vec/vec0.so',
    '/x/sqlite-vec/vec0.dylib',
  ]
  assert.equal(pickSqliteVecLibrary(files, 'linux'), '/x/sqlite-vec/vec0.so')
  assert.equal(pickSqliteVecLibrary(files, 'darwin'), '/x/sqlite-vec/vec0.dylib')
  assert.equal(pickSqliteVecLibrary(['C:\\a\\vec0.dll'], 'win32'), 'C:\\a\\vec0.dll')
})

test('returns null when the archive has no vec0 for the platform', () => {
  assert.equal(pickSqliteVecLibrary(['/x/vec0.dylib', '/x/libfoo.so'], 'linux'), null)
})

test('refuses an archive with two vec0 libraries', () => {
  assert.throws(() => pickSqliteVecLibrary(['/a/vec0.so', '/b/vec0.so'], 'linux'), /2 copies/)
})
