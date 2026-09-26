#!/usr/bin/env node
/**
 * Refuse to package placeholders.
 *
 * `scripts/check-tauri-resources.mjs` answers "is the path there", which is the
 * question the Tauri build script asks and the question a contributor needs
 * answered on a fresh clone. This asks the packaging question instead: is each
 * bundled program a real executable image, for this OS and this processor, and
 * can it be started.
 *
 * The two are deliberately separate. A compile-only run wants stubs and should
 * keep being allowed to make them; a `tauri build` must never see one. So this
 * runs in the release path only, and it names a stub as a stub rather than
 * letting it through as "present".
 *
 * Every binary it clears is reported with its size and SHA-256, so the manifest
 * of what went into a package is a by-product of the check that admitted it
 * rather than a separate document that can disagree with the build.
 *
 * Usage:
 *   node scripts/check-sidecars.mjs             # check for the host triple
 *   node scripts/check-sidecars.mjs --target <triple>
 *   node scripts/check-sidecars.mjs --manifest <path>   # also write the manifest
 *   node scripts/check-sidecars.mjs --no-probe          # skip the startup probe
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspect, parseTriple } from './sidecar-integrity.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
const probe = !args.includes('--no-probe')

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  const line = out.split('\n').find((l) => l.startsWith('host:'))
  if (!line) throw new Error('rustc -vV did not report a host triple')
  return line.slice('host:'.length).trim()
}

const triple = argOf('--target') ?? hostTriple()
const { family } = parseTriple(triple)
const configName =
  family === 'windows'
    ? 'tauri.windows.conf.json'
    : family === 'darwin'
      ? 'tauri.macos.conf.json'
      : 'tauri.linux.conf.json'

const configPath = join(root, 'src-tauri', configName)
if (!existsSync(configPath)) {
  console.error(`cannot check sidecars: ${configName} is missing`)
  process.exit(1)
}
const bundle = JSON.parse(readFileSync(configPath, 'utf8')).bundle ?? {}

/** Expand the one glob shape these configs use (`libggml*.so*`). */
function expand(declared) {
  const full = join(root, 'src-tauri', declared)
  if (!declared.includes('*')) return [full]
  const dir = dirname(full)
  if (!existsSync(dir)) return []
  const pattern = full.slice(dir.length + 1)
  const rx = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  )
  return readdirSync(dir)
    .filter((name) => rx.test(name))
    .map((name) => join(dir, name))
}

/**
 * Which declared paths are programs?
 *
 * `externalBin` always is, by definition. Under `bundle.resources` only the
 * contents of `resources/bin` are -- `resources/LICENSE` is a text file and
 * demanding a PE header of it would be the check crying wolf.
 */
const targets = []
for (const declared of bundle.externalBin ?? []) {
  targets.push({
    declared: `${declared}-${triple}${family === 'windows' ? '.exe' : ''}`,
    kind: 'externalBin',
    library: false,
  })
}
for (const declared of bundle.resources ?? []) {
  if (!declared.startsWith('resources/bin/')) continue
  targets.push({ declared, kind: 'resource' })
}

if (targets.length === 0) {
  console.error(`No sidecars are declared in ${configName}; nothing to verify.`)
  console.error('That is itself suspicious for a packaging run -- check the config.')
  process.exit(1)
}

const cleared = []
const failures = []

for (const target of targets) {
  const paths = expand(target.declared)
  if (paths.length === 0) {
    failures.push({
      path: `src-tauri/${target.declared}`,
      problems: [target.declared.includes('*') ? 'no file matches this glob' : 'missing'],
    })
    continue
  }
  for (const path of paths) {
    // A `.bundle` (mlx-swift's Metal shader library) is a directory of
    // resources, not a program: nothing in it is executed, so there is no
    // image to inspect. Leave it to Tauri's resource copy.
    if (existsSync(path) && statSync(path).isDirectory()) continue
    // A shared library is loaded, not executed: on unix it legitimately has no
    // execute bit, and requiring one would fail every correct build. Decided
    // from the resolved filename, never the declared pattern -- the config says
    // `libggml*.so*`, in which `.so` is not the extension of anything.
    const library = /\.(dll|so|dylib)(\.|$)/.test(path)
    const result = inspect(path, triple, { requireExecutable: !library })
    const rel = path.slice(root.length + 1)
    if (!result.ok) {
      failures.push({ path: rel, problems: result.problems })
      continue
    }
    cleared.push({
      path: rel,
      kind: target.kind,
      bytes: result.size,
      sha256: result.sha256,
      format: result.format,
      architectureVerified: result.machineChecked === true,
    })
  }
}

/**
 * Ask the binary to say something and exit.
 *
 * Only for host-native executables: a cross-built sidecar cannot run here, and
 * a check that fails for the correct reason on a correct build is worse than no
 * check. Libraries are not started at all. Failure is reported, never ignored --
 * a program that will not answer `--version` is not a program that will serve a
 * user, and this is the last moment before it is inside an installer.
 */
if (probe && triple === hostTriple()) {
  for (const entry of cleared) {
    if (entry.kind !== 'externalBin') continue
    const out = spawnSync(join(root, entry.path), ['--version'], {
      timeout: 20000,
      encoding: 'utf8',
    })
    if (out.error) {
      failures.push({ path: entry.path, problems: [`will not start: ${out.error.message}`] })
    } else {
      entry.probe = `--version -> exit ${out.status}`
    }
  }
}

if (failures.length > 0) {
  console.error(`Sidecar verification failed for ${triple} (${configName}):`)
  for (const failure of failures) {
    console.error(`  ${failure.path}`)
    for (const problem of failure.problems) console.error(`      ${problem}`)
  }
  console.error('')
  console.error('A zero-byte or wrong-architecture sidecar means a build stub reached the')
  console.error('packaging path. Stubs come from scripts/stub-tauri-resources.sh and are for')
  console.error('compile-only runs; a release build needs the real binaries:')
  console.error('')
  console.error('  yarn download:bin && yarn build:cli && yarn build:web')
  console.error('')
  console.error('Delete the stubs first -- they are guarded on existence, so a stub already')
  console.error('in place is never replaced:')
  console.error('')
  console.error('  rm -f src-tauri/resources/bin/*')
  process.exit(1)
}

console.log(`Sidecars verified for ${triple} (${configName}):`)
for (const entry of cleared) {
  console.log(
    `  ${entry.path}  ${entry.bytes} bytes  ${entry.format}` +
      `${entry.architectureVerified ? '' : ' (architecture unverified)'}` +
      `${entry.probe ? `  ${entry.probe}` : ''}`
  )
  console.log(`      sha256 ${entry.sha256}`)
}

const manifest = argOf('--manifest')
if (manifest) {
  writeFileSync(
    manifest,
    JSON.stringify({ target: triple, config: configName, sidecars: cleared }, null, 2) + '\n'
  )
  console.log(`Manifest written to ${manifest}`)
}
