#!/usr/bin/env node
/**
 * Are the files `generate_context!()` insists on actually there?
 *
 * The Tauri build script validates every path declared under `bundle.resources`
 * and `bundle.externalBin`, plus the icons and `frontendDist`, and it does so
 * *before* compiling anything. A fresh checkout has none of them, so the first
 * failure a contributor meets is not a test failure — it is
 *
 *   error: failed to run custom build command for `Jan v0.8.4`
 *   resource path `resources/bin/jan` doesn't exist
 *
 * with no indication of what to do about it. That message costs whoever hits
 * it a search through the Makefile; this script answers it directly.
 *
 * Read from the same `tauri.<os>.conf.json` the build script reads, so the two
 * cannot drift: a resource added to the bundle config is checked here without
 * anyone remembering to add it.
 *
 * Exit 0 when everything a build needs is present, 1 when something is not —
 * and in that case print the paths and the exact command that creates them.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The per-OS config the build script will actually read. */
function platformConfig() {
  switch (process.platform) {
    case 'darwin':
      return 'tauri.macos.conf.json'
    case 'win32':
      return 'tauri.windows.conf.json'
    default:
      return 'tauri.linux.conf.json'
  }
}

/**
 * The Rust host triple, which `externalBin` paths are suffixed with.
 *
 * Tauri appends it itself — the config says `resources/bin/uv` and the file on
 * disk is `resources/bin/uv-x86_64-unknown-linux-gnu`. Asked of `rustc` rather
 * than derived from `process.platform`, because guessing it is how a checker
 * ends up disagreeing with the build it is meant to predict.
 */
function hostTriple() {
  try {
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    const line = out.split('\n').find((l) => l.startsWith('host:'))
    return line ? line.slice('host:'.length).trim() : null
  } catch {
    return null
  }
}

/**
 * Does anything match this declared path?
 *
 * `resources` entries may be globs (`resources/bin/libggml*.so*`), and a glob
 * matching nothing is an error to Tauri (`GlobPathNotFound`), not an empty
 * set — so "no match" is a real failure and is reported as one. Only the
 * simple `*` case appears in these configs, so this deliberately implements
 * that and nothing more rather than pulling in a glob dependency.
 */
function satisfied(declared) {
  const full = join(root, 'src-tauri', declared)
  if (!declared.includes('*')) return existsSync(full)
  const dir = dirname(full)
  if (!existsSync(dir)) return false
  const pattern = full.slice(dir.length + 1)
  const rx = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  )
  return readdirSync(dir).some((name) => rx.test(name))
}

const config = platformConfig()
const configPath = join(root, 'src-tauri', config)
if (!existsSync(configPath)) {
  console.error(`cannot check resources: ${config} is missing`)
  process.exit(1)
}
const bundle = JSON.parse(readFileSync(configPath, 'utf8')).bundle ?? {}

const missing = []

for (const declared of bundle.resources ?? []) {
  if (!satisfied(declared)) missing.push(`src-tauri/${declared}`)
}

const triple = hostTriple()
for (const declared of bundle.externalBin ?? []) {
  // Without rustc there is no way to know the suffix, and a checker that
  // guesses would report a false failure. Say what it could not check.
  if (!triple) {
    console.error(
      `cannot check ${declared}: rustc is not on PATH, so the host triple is unknown`
    )
    process.exit(1)
  }
  // Tauri appends the host triple, and on Windows the `.exe` extension too, so
  // the file on disk is `bun-x86_64-pc-windows-msvc.exe`. Checking for the
  // unsuffixed name reports every Windows build as missing its sidecars.
  const suffixed = `${declared}-${triple}${process.platform === 'win32' ? '.exe' : ''}`
  if (!satisfied(suffixed)) missing.push(`src-tauri/${suffixed}`)
}

// Icons and the built frontend are validated by the same build script and are
// gitignored, so they are missing on a fresh checkout exactly as the bundle
// resources are.
for (const icon of [
  '32x32.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.icns',
  'icon.ico',
]) {
  if (!satisfied(`icons/${icon}`)) missing.push(`src-tauri/icons/${icon}`)
}
if (!existsSync(join(root, 'web-app/dist/index.html'))) {
  missing.push('web-app/dist/index.html')
}

if (missing.length === 0) {
  console.log(
    `Tauri bundle resources present for ${config}${triple ? ` (${triple})` : ''}.`
  )
  process.exit(0)
}

console.error(
  `Missing ${missing.length} path${missing.length === 1 ? '' : 's'} that the Tauri build script requires (${config}):`
)
for (const path of missing) console.error(`  ${path}`)
console.error('')
console.error(
  'These are gitignored build outputs, so a fresh checkout has none of them.'
)
console.error(
  'Any `cargo` command touching the app crate fails on the first one, before'
)
console.error('a single test runs. To create placeholders and continue:')
console.error('')
console.error(
  '  ./scripts/stub-tauri-resources.sh      (or: make stub-resources)'
)
console.error('')
console.error(
  'That is enough for tests, clippy and any compile-only run. For a real'
)
console.error('application build you want the real binaries instead:')
console.error('')
console.error('  yarn download:bin && yarn build:cli && yarn build:web')
process.exit(1)
