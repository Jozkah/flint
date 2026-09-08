import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A fresh checkout must be able to run the checks, without a scavenger hunt.
 *
 * The Tauri build script validates every `bundle.resources` path, every
 * `externalBin`, the icons and `frontendDist` *before* compiling anything, and
 * all of those are gitignored build outputs. So on a clone, the first thing a
 * contributor sees from any `cargo` command touching the app crate is
 *
 *   error: failed to run custom build command for `Jan v0.8.4`
 *   resource path `resources/bin/jan` doesn't exist
 *
 * which says nothing about the remedy. `scripts/check-tauri-resources.mjs`
 * answers it; these are the guards on the three ways that stops being true —
 * the checker drifting from the bundle config, the smoke script going back to
 * assuming a prepared tree, and the remedy it prints ceasing to exist.
 *
 * Deliberately assertions about the repository's own files rather than a
 * runtime: nothing here compiles Rust or downloads anything.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO = resolve(HERE, '../../..')

const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8')

describe('the Tauri resource preflight', () => {
  it('passes on a tree that has been prepared', () => {
    // The suite only runs where the smoke script or `make stub-resources` has
    // already prepared the tree, which is the state this asserts. A failure
    // here means the checker and the stub script disagree about what the
    // bundle config declares — the exact drift it exists to catch.
    const out = execFileSync(
      process.execPath,
      [join(REPO, 'scripts/check-tauri-resources.mjs')],
      { cwd: REPO, encoding: 'utf8' }
    )
    expect(out).toMatch(/resources present/)
  })

  it('names the missing path and the exact remedy, and fails', () => {
    // Driven through a copied config rather than by deleting a real resource:
    // a test that removes build outputs from the working tree would break the
    // run it is part of.
    const dir = mkdtempSync(join(tmpdir(), 'jan-resources-'))
    try {
      const script = read('scripts/check-tauri-resources.mjs')
      // Point the checker at an empty tree by giving it a root with the config
      // it reads and nothing else.
      const fakeRoot = join(dir, 'repo')
      const tauri = join(fakeRoot, 'src-tauri')
      execFileSync('mkdir', ['-p', join(tauri), join(fakeRoot, 'scripts')])
      for (const name of [
        'tauri.linux.conf.json',
        'tauri.macos.conf.json',
        'tauri.windows.conf.json',
      ]) {
        writeFileSync(join(tauri, name), read(`src-tauri/${name}`))
      }
      writeFileSync(join(fakeRoot, 'scripts/check-tauri-resources.mjs'), script)

      let failed = false
      let output = ''
      try {
        execFileSync(
          process.execPath,
          [join(fakeRoot, 'scripts/check-tauri-resources.mjs')],
          { cwd: fakeRoot, encoding: 'utf8', stdio: 'pipe' }
        )
      } catch (e) {
        failed = true
        output = String((e as { stderr?: Buffer }).stderr ?? '')
      }

      expect(failed).toBe(true)
      // The paths, so the reader knows what is missing...
      expect(output).toContain('src-tauri/resources/LICENSE')
      // ...and the command that creates them, verbatim.
      expect(output).toContain('./scripts/stub-tauri-resources.sh')
      expect(output).toContain('make stub-resources')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is what the smoke script runs before it needs cargo', () => {
    // The discovery step this removes: previously the two `cargo test` checks
    // died on a fresh checkout and whoever hit it had to find the stub script
    // in the Makefile.
    const smoke = read('scripts/cowork-compat-smoke.sh')
    expect(smoke).toContain('scripts/stub-tauri-resources.sh')
    expect(smoke).toContain('scripts/check-tauri-resources.mjs')
    // Before the first cargo *invocation*, or it is not a preflight. Matched
    // as a command at the start of a line, because the prose above it names
    // `cargo test` too and a plain substring search finds the comment first.
    const firstCargo = smoke.search(/^\s*cargo test /m)
    expect(firstCargo).toBeGreaterThan(-1)
    expect(smoke.indexOf('check-tauri-resources.mjs')).toBeLessThan(firstCargo)
  })

  it('offers the same preparation as a named command', () => {
    // So the remedy printed on failure, the smoke script and the Makefile are
    // three routes to one implementation rather than three descriptions of it.
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['check:resources']).toContain(
      'check-tauri-resources.mjs'
    )
    expect(pkg.scripts['prepare:resources']).toContain(
      'stub-tauri-resources.sh'
    )
    expect(read('Makefile')).toContain('check-tauri-resources.mjs')
  })

  it('checks every resource the bundle config actually declares', () => {
    // The drift guard. A resource added to `tauri.linux.conf.json` is checked
    // because the checker reads that file — not because someone remembered to
    // add it here.
    const checker = read('scripts/check-tauri-resources.mjs')
    expect(checker).toContain('bundle.resources')
    expect(checker).toContain('externalBin')
    // The host triple is asked of rustc, not guessed from process.platform:
    // externalBin paths are suffixed with it, and a guess would disagree with
    // the build it predicts.
    expect(checker).toContain('rustc')
  })
})
