// Ratchet on panicking calls in production Rust (audit STD-002).
//
//   node scripts/unwrap-ratchet.mjs            # fail only if a file gained sites
//   node scripts/unwrap-ratchet.mjs --update   # rewrite the baseline (after a burn-down)
//
// Counts `.unwrap()`, `.expect(` and `panic!(` in src-tauri/src and
// src-tauri/plugins/*/src, skipping test files and everything from a file's
// first `#[cfg(test)]` on. The existing debt is the baseline and never fails
// the check; a file whose count grows above it does, so no new site lands
// unnoticed. A file that drops below its baseline only prints a hint to run
// --update, so burning sites down never breaks anything.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const PATTERN = /\.unwrap\(\)|\.expect\(|\bpanic!\(/g

/** Panicking sites in one file's production part. */
export function countSites(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const cut = lines.findIndex((l) => l.trim().startsWith('#[cfg(test)]'))
  let n = 0
  for (const line of cut === -1 ? lines : lines.slice(0, cut)) {
    const code = line.replace(/\/\/.*$/, '')
    n += (code.match(PATTERN) ?? []).length
  }
  return n
}

const isTestPath = (rel) => /(^|\/)(tests?|benches)(\/|$)|_tests?\.rs$|(^|\/)tests?\.rs$/.test(rel)

function* rustFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'target' && name !== 'node_modules') yield* rustFiles(path)
    } else if (name.endsWith('.rs')) yield path
  }
}

/** { 'path/relative/to/root.rs': count } for every file with at least one site. */
export function scan(root) {
  const dirs = [join(root, 'src-tauri', 'src')]
  const plugins = join(root, 'src-tauri', 'plugins')
  if (existsSync(plugins)) {
    for (const p of readdirSync(plugins)) {
      const src = join(plugins, p, 'src')
      if (existsSync(src)) dirs.push(src)
    }
  }
  const counts = {}
  for (const dir of dirs.filter(existsSync)) {
    for (const file of rustFiles(dir)) {
      const rel = relative(root, file).split(sep).join('/')
      if (isTestPath(rel)) continue
      const n = countSites(readFileSync(file, 'utf8'))
      if (n > 0) counts[rel] = n
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/** Files above their baseline (new sites), and files below it (stale baseline). */
export function compare(counts, baseline) {
  const grown = []
  const shrunk = []
  for (const [file, n] of Object.entries(counts)) {
    const was = baseline[file] ?? 0
    if (n > was) grown.push({ file, was, now: n })
  }
  for (const [file, was] of Object.entries(baseline)) {
    const n = counts[file] ?? 0
    if (n < was) shrunk.push({ file, was, now: n })
  }
  return { grown, shrunk }
}

if (process.argv[1]?.endsWith('unwrap-ratchet.mjs')) {
  const root = join(import.meta.dirname, '..')
  const baselineFile = join(import.meta.dirname, 'unwrap-ratchet-baseline.json')
  const counts = scan(root)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (process.argv.includes('--update')) {
    writeFileSync(baselineFile, JSON.stringify(counts, null, 2) + '\n')
    console.log(`Baseline written: ${total} sites in ${Object.keys(counts).length} files.`)
    process.exit(0)
  }
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {}
  const { grown, shrunk } = compare(counts, baseline)
  for (const s of shrunk) console.log(`${s.file}: ${s.was} -> ${s.now} (run with --update to lock it in)`)
  if (grown.length) {
    for (const g of grown) {
      console.error(`${g.file}: ${g.was} -> ${g.now} unwrap/expect/panic in non-test code`)
    }
    console.error('New panicking calls: return an error instead, or move the code under #[cfg(test)].')
    process.exit(1)
  }
  console.log(`unwrap ratchet ok: ${total} sites, none new.`)
}
