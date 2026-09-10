import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSafeArchivePath, assertSafeTarEntry, assertSafeZipEntry } from './archive-extract-guard.mjs'

test('rejects unsafe archive entry paths', () => {
  assert.throws(() => assertSafeArchivePath('../escape.txt', 'scripts/dist', '.zip'), /Unsafe \.zip entry path/)
  assert.throws(() => assertSafeArchivePath('nested/../../escape.txt', 'scripts/dist', '.tar.gz'), /Unsafe \.tar\.gz entry path/)
  assert.throws(() => assertSafeArchivePath('/etc/passwd', 'scripts/dist', '.zip'), /Unsafe \.zip entry path/)
  assert.throws(
    () => assertSafeArchivePath('C:/Windows/System32/drivers/etc/hosts', 'scripts/dist', '.zip'),
    /Unsafe \.zip entry path/
  )
  assert.throws(() => assertSafeArchivePath('..\\escape.txt', 'scripts/dist', '.zip'), /Unsafe \.zip entry path/)
  assert.doesNotThrow(() => assertSafeArchivePath('nested/file.txt', 'scripts/dist', '.zip'))
})

// The check unzipper 0.12 makes itself is a bare prefix test, which a sibling
// directory sharing the target's name as a prefix passes.
test('rejects an entry that lands in a sibling sharing the target prefix', () => {
  assert.throws(
    () => assertSafeArchivePath('../dist-evil/payload.exe', 'scripts/dist', '.zip'),
    /Unsafe \.zip entry path/
  )
  assert.throws(
    () => assertSafeArchivePath('nested/../../dist-evil/payload.exe', 'scripts/dist', '.zip'),
    /Unsafe \.zip entry path/
  )
})

test('rejects links, which could point an entry outside the target', () => {
  const zipLink = { path: 'bin/tool', externalFileAttributes: (0o120777 << 16) >>> 0 }
  assert.throws(() => assertSafeZipEntry(zipLink, 'scripts/dist'), /Unsafe \.zip entry type/)
  assert.doesNotThrow(() =>
    assertSafeZipEntry({ path: 'bin/tool', externalFileAttributes: (0o100755 << 16) >>> 0 }, 'scripts/dist')
  )
  for (const type of ['SymbolicLink', 'Link']) {
    assert.throws(() => assertSafeTarEntry('bin/tool', { type }, 'scripts/dist'), /Unsafe \.tar\.gz entry type/)
  }
  assert.doesNotThrow(() => assertSafeTarEntry('bin/tool', { type: 'File' }, 'scripts/dist'))
})
