// Ratchet on large web-app source files that have no test of their own.
//
//   node scripts/untested-ui-ratchet.mjs            # fail on a new or much larger one
//   node scripts/untested-ui-ratchet.mjs --update   # rewrite the baseline
//
// A source file under web-app/src counts as large at LARGE_LINES lines and as
// tested when some test file anywhere under web-app/src is named after it
// (`Name.test.tsx`, `Name.spec.ts`, ...). The large untested files that exist
// today are the baseline and never fail the check. A large untested file that
// is not in the baseline fails, and so does a baselined one that grows more
// than GROWTH_ALLOWANCE above its recorded size: split it or give it a test.
// A file that got a test, or shrank below the line, only prints a hint to run
// --update, so paying the debt down never breaks anything.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

export const LARGE_LINES = 800
export const GROWTH_ALLOWANCE = 0.1

const SOURCE = /\.(ts|tsx)$/
const TEST = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/
// Declarations, generated route trees and static data tables: nothing to test.
const GENERATED = /\.(d|gen|data)\.ts$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '__mocks__', 'dev', 'locales'])

/** The name a test file would carry for `file`: `Foo.tsx` -> `Foo`. */
export const stem = (file) => basename(file).replace(/\.(test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '')

export const lineCount = (text) => text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length

function* walk(dir, inTests = false) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue
      yield* walk(path, inTests || SKIP_DIRS.has(name))
    } else {
      yield { path, name, inTests: inTests }
    }
  }
}

/** { 'web-app/src/...': lines } for every large source file without a test named after it. */
export function scan(root) {
  const src = join(root, 'web-app', 'src')
  if (!existsSync(src)) return {}
  const tested = new Set()
  const sources = []
  for (const { path, name, inTests } of walk(src)) {
    if (TEST.test(name)) tested.add(stem(name))
    else if (!inTests && SOURCE.test(name) && !GENERATED.test(name)) sources.push(path)
  }
  const out = {}
  for (const path of sources) {
    if (tested.has(stem(path))) continue
    const lines = lineCount(readFileSync(path, 'utf8'))
    if (lines >= LARGE_LINES) out[relative(root, path).split(sep).join('/')] = lines
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

/** New large untested files, baselined ones that grew past the allowance, and stale entries. */
export function compare(found, baseline) {
  const added = []
  const grown = []
  const stale = []
  for (const [file, lines] of Object.entries(found)) {
    const was = baseline[file]
    if (was === undefined) added.push({ file, lines })
    else if (lines > Math.ceil(was * (1 + GROWTH_ALLOWANCE))) grown.push({ file, was, lines })
  }
  for (const [file, was] of Object.entries(baseline)) {
    const lines = found[file]
    if (lines === undefined || lines < was) stale.push({ file, was, lines: lines ?? 0 })
  }
  return { added, grown, stale }
}

if (process.argv[1]?.endsWith('untested-ui-ratchet.mjs')) {
  const root = join(import.meta.dirname, '..')
  const baselineFile = join(import.meta.dirname, 'untested-ui-baseline.json')
  const found = scan(root)
  if (process.argv.includes('--update')) {
    writeFileSync(baselineFile, JSON.stringify(found, null, 2) + '\n')
    console.log(`Baseline written: ${Object.keys(found).length} large untested files.`)
    process.exit(0)
  }
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {}
  const { added, grown, stale } = compare(found, baseline)
  for (const s of stale) {
    console.log(`${s.file}: ${s.was} -> ${s.lines || 'tested or small'} (run with --update to lock it in)`)
  }
  if (added.length || grown.length) {
    for (const a of added) console.error(`${a.file}: ${a.lines} lines and no test named after it`)
    for (const g of grown) console.error(`${g.file}: grew ${g.was} -> ${g.lines} lines with no test named after it`)
    console.error(`Files over ${LARGE_LINES} lines need a test named after them (Name.test.tsx), or a split.`)
    process.exit(1)
  }
  console.log(`untested UI ratchet ok: ${Object.keys(found).length} large untested files, none new.`)
}
