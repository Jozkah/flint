#!/usr/bin/env node
/**
 * Command-surface guard.
 *
 * Every recurring IPC defect in the audit had one signature: a
 * `#[tauri::command]` parameter named `path`, `destination`, `data_folder`,
 * `project`, `root` or `folder` that reaches the filesystem unbounded. This
 * flags such parameters at PR time.
 *
 * A command is accepted when it carries a comment
 *   // ipc-scope: <how the path is bounded>
 * on a line inside the attribute/signature block (or directly above it), or
 * when its `file::fn::param` key is in scripts/command-surface-baseline.json
 * (the findings that existed when the guard landed; only NEW ones fail).
 *
 * Usage:  node scripts/command-surface-guard.mjs [--update-baseline]
 * Exit:   0 clean, 1 new findings.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = 'src-tauri/src'
const BASELINE = 'scripts/command-surface-baseline.json'

export const RISKY = new Set(['path', 'destination', 'data_folder', 'project', 'root', 'folder'])

/** Return `[{ fn, param }]` risky parameters of un-annotated commands in `source`. */
export function scanSource(source) {
  const text = source.replace(/\r\n/g, '\n')
  const out = []
  const re = /#\[tauri::command[^\]]*\]/g
  let m
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index)
    const sig = /\bfn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/.exec(rest)
    if (!sig) continue
    const open = m.index + sig.index + sig[0].length
    let depth = 1
    let i = open
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]
      if (c === '(') depth++
      else if (c === ')') depth--
    }
    const params = text.slice(open, i - 1)
    // The annotation window: two lines above the attribute through the signature.
    const before = text.slice(0, m.index).split('\n').slice(-3).join('\n')
    const block = before + text.slice(m.index, i)
    if (/\/\/\s*ipc-scope:/.test(block)) continue
    for (const p of params.matchAll(/(?:^|[\s,(])(?:mut\s+)?(\w+)\s*:/g)) {
      if (RISKY.has(p[1])) out.push({ fn: sig[1], param: p[1] })
    }
  }
  return out
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.rs')) acc.push(p)
  }
  return acc
}

export function findAll(root = repoRoot) {
  const keys = new Set()
  for (const file of walk(path.join(root, SRC))) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    for (const f of scanSource(fs.readFileSync(file, 'utf8'))) keys.add(`${rel}::${f.fn}::${f.param}`)
  }
  return [...keys].sort()
}

export function newFindings(found, baseline) {
  const known = new Set(baseline)
  return found.filter((k) => !known.has(k))
}

function main() {
  const found = findAll()
  const baselinePath = path.join(repoRoot, BASELINE)
  if (process.argv.includes('--update-baseline')) {
    fs.writeFileSync(baselinePath, JSON.stringify(found, null, 2) + '\n')
    console.log(`baseline written: ${found.length} entries`)
    return 0
  }
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : []
  const fresh = newFindings(found, baseline)
  if (fresh.length === 0) {
    console.log(`command-surface-guard: ok (${found.length} baselined)`)
    return 0
  }
  console.error('command-surface-guard: new path-like command parameters without `// ipc-scope:`')
  for (const k of fresh) console.error(`  ${k}`)
  console.error('Bound the path (data folder, dialog, registry) and add `// ipc-scope: <how>` above the command.')
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
