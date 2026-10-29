#!/usr/bin/env node
// Bundle size budget for the web app (XCUT-019).
//
// Reads a built `web-app/dist`, measures the gzip size of the entry chunk (the
// scripts index.html loads), of all JavaScript and of all CSS, and compares
// them with scripts/bundle-budget.json. Growth up to the allowance (10%) is
// reported and passes; more fails. Shrinking always passes.
//
//   node scripts/check-bundle-size.mjs [distDir]          check
//   node scripts/check-bundle-size.mjs [distDir] --update rewrite the baseline
//
// Run it after `yarn workspace @janhq/web-app build`. A missing dist is an
// error, so a broken build cannot pass the check by producing nothing.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const budgetPath = join(root, 'scripts', 'bundle-budget.json')

export function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const gz = (file) => gzipSync(readFileSync(file), { level: 9 }).length

/** Measures a dist folder: gzip bytes of the entry scripts, all JS, all CSS. */
export function measure(dist) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const entries = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) =>
    join(dist, m[1].replace(/^\.?\//, ''))
  )
  const files = walk(dist)
  const sum = (list) => list.reduce((n, f) => n + gz(f), 0)
  return {
    entryJs: sum(entries.filter((f) => existsSync(f))),
    totalJs: sum(files.filter((f) => f.endsWith('.js'))),
    totalCss: sum(files.filter((f) => f.endsWith('.css'))),
  }
}

/** Compares a measurement with a budget; returns one line per metric. */
export function compare(current, budget) {
  const allowance = budget.allowance ?? 0.1
  return Object.keys(budget.metrics).map((key) => {
    const base = budget.metrics[key]
    const now = current[key] ?? 0
    const growth = base > 0 ? (now - base) / base : 0
    return { key, base, now, growth, over: growth > allowance }
  })
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`

function main(argv) {
  const update = argv.includes('--update')
  const distArg = argv.find((a) => !a.startsWith('--'))
  const dist = resolve(distArg ?? join(root, 'web-app', 'dist'))
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`check-bundle-size: no build at ${dist}; run the web-app build first`)
    return 1
  }
  const current = measure(dist)
  if (update) {
    const prev = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, 'utf8')) : {}
    const next = { allowance: prev.allowance ?? 0.1, metrics: current }
    writeFileSync(budgetPath, JSON.stringify(next, null, 2) + '\n')
    console.log(`check-bundle-size: baseline written to ${relative(root, budgetPath)}`)
    return 0
  }
  const budget = JSON.parse(readFileSync(budgetPath, 'utf8'))
  const rows = compare(current, budget)
  let failed = false
  for (const r of rows) {
    const pct = `${r.growth >= 0 ? '+' : ''}${(r.growth * 100).toFixed(1)}%`
    console.log(`${r.over ? 'OVER' : 'ok  '} ${r.key}: ${kb(r.now)} (baseline ${kb(r.base)}, ${pct})`)
    failed ||= r.over
  }
  if (failed) {
    console.error(
      `check-bundle-size: gzip size grew more than ${(budget.allowance * 100).toFixed(0)}% over the baseline. ` +
        'Find what grew (a new dependency in the entry chunk is the usual cause) or, if the growth is ' +
        'intended, run `node scripts/check-bundle-size.mjs --update` and commit scripts/bundle-budget.json.'
    )
    return 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
