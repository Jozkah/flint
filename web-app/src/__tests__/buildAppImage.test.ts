import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #157: buildAppImage.sh had no `set -e` and did not check the copy of the bun
 * sidecar, so a failed copy still repackaged an AppImage and exited 0.
 *
 * The script runs in a scratch directory with a stub `wget` (no network) that
 * writes an `appimagetool` which only leaves a marker file. It is fed on stdin
 * with CRs stripped, so a CRLF checkout on Windows runs too.
 */
const HERE = resolve(fileURLToPath(import.meta.url), '..')
const SCRIPT = readFileSync(
  resolve(HERE, '../../../src-tauri/build-utils/buildAppImage.sh'),
  'utf8'
).replace(/\r/g, '')
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0

const WGET_STUB = `#!/bin/bash
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-O" ]; then out="$2"; fi
  shift
done
printf '#!/bin/bash\\ntouch appimagetool-ran\\n' > "$out"
`

// The stub download is not the pinned release, so its SHA-256 check is stubbed.
// A shell function, not a file: executing a just-written file can fail with
// ETXTBSY when another test process forks at the same moment.
const SHA256SUM_STUB = 'sha256sum() { return 0; }'

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe.skipIf(!hasBash)('buildAppImage.sh', () => {
  it('fails, without repackaging, when the bun sidecar cannot be copied', () => {
    dir = mkdtempSync(join(tmpdir(), 'appimage-'))
    mkdirSync(join(dir, 'stub'))
    writeFileSync(join(dir, 'stub', 'wget'), WGET_STUB, { mode: 0o755 })
    // An AppDir and a tauri-built AppImage exist; the bun binary does not.
    mkdirSync(join(dir, 'src-tauri/target/release/bundle/appimage/Flint.AppDir/usr/bin'), {
      recursive: true,
    })
    writeFileSync(join(dir, 'src-tauri/target/release/bundle/appimage/Flint.AppImage'), 'x')

    const run = spawnSync('bash', ['-s'], {
      cwd: dir,
      input: `export PATH="$PWD/stub:$PATH"\n${SHA256SUM_STUB}\n${SCRIPT}`,
      encoding: 'utf8',
    })

    expect(run.status).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('Failed to copy the bun sidecar')
    expect(existsSync(join(dir, 'appimagetool-ran'))).toBe(false)
    // The AppImage tauri built is left alone rather than deleted.
    expect(existsSync(join(dir, 'src-tauri/target/release/bundle/appimage/Flint.AppImage'))).toBe(true)
  })

  it('fails, without repackaging, when the AppDir bundles the host Vulkan loader', () => {
    dir = mkdtempSync(join(tmpdir(), 'appimage-'))
    mkdirSync(join(dir, 'stub'))
    writeFileSync(join(dir, 'stub', 'wget'), WGET_STUB, { mode: 0o755 })
    const appDir = join(dir, 'src-tauri/target/release/bundle/appimage/Flint.AppDir')
    mkdirSync(join(appDir, 'usr/bin'), { recursive: true })
    mkdirSync(join(appDir, 'usr/lib'), { recursive: true })
    writeFileSync(join(appDir, '.DirIcon'), 'x')
    writeFileSync(join(appDir, 'usr/lib/libvulkan.so.1'), 'x')
    mkdirSync(join(dir, 'src-tauri/resources/bin'), { recursive: true })
    writeFileSync(join(dir, 'src-tauri/resources/bin/bun'), 'x')
    writeFileSync(join(dir, 'src-tauri/target/release/bundle/appimage/Flint.AppImage'), 'x')

    const run = spawnSync('bash', ['-s'], {
      cwd: dir,
      input: `export PATH="$PWD/stub:$PATH"\n${SHA256SUM_STUB}\n${SCRIPT}`,
      encoding: 'utf8',
    })

    expect(run.status).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('libvulkan.so.1')
    expect(existsSync(join(dir, 'appimagetool-ran'))).toBe(false)
  })
})
