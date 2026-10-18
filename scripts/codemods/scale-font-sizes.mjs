#!/usr/bin/env node
// Rewrites hard-coded font sizes in web-app/src so they follow the Font Size
// setting. At the default 16px base every rewritten size renders exactly as
// before: N px becomes calc(var(--ui-font-base) * N/16), N rem becomes
// calc(var(--ui-font-base) * N).
//
// --ui-font-base (index.css) is --font-size-base where the page is not CSS
// zoomed, and the design base (16px) inside .app-zoom, where zoom already
// scales everything, so text never grows twice.
//
// Touches: Tailwind text-[Npx|Nrem] classes (with any variant prefix or !),
// leading-[Npx] on a line that also carries a converted text size, numeric or
// 'Npx' inline fontSize literals in .tsx, and `font-size: Npx|rem` in .css.
// Skips: src/mobile (separate design), locales, generated files, node_modules,
// and the entries in src/__tests__/fixed-font-sizes.allowlist.json.
// Idempotent: converted values no longer match. Usage:
//   node scripts/codemods/scale-font-sizes.mjs [--check]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const webApp = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'web-app')
const src = join(webApp, 'src')
const check = process.argv.includes('--check')
const allow = JSON.parse(
  readFileSync(join(src, '__tests__', 'fixed-font-sizes.allowlist.json'), 'utf8')
).entries

const SKIP_DIRS = new Set(['node_modules', 'mobile', 'locales'])
const SKIP_FILES = new Set(['routeTree.gen.ts'])

const fmt = (n) => String(Number(n.toFixed(6)))
const factor = (num, unit) => fmt(unit === 'px' ? Number(num) / 16 : Number(num))
const calc = (f) => `calc(var(--ui-font-base)*${f})`

const TEXT_RE = /(?<![\w-])text-\[(\d*\.?\d+)(px|rem)\]/g
const LEADING_RE = /(?<![\w-])leading-\[(\d*\.?\d+)px\]/g
const INLINE_RE = /\bfontSize:\s*(?:(\d*\.?\d+)|'(\d*\.?\d+)px')(?=\s*[,}\n])/g
const CSS_RE = /font-size:\s*(\d*\.?\d+)(px|rem)(\s*!important)?;/g

const counts = { textPx: 0, textRem: 0, leading: 0, inline: 0, css: 0, files: 0 }

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out)
    } else if (/\.(tsx?|css)$/.test(name) && !SKIP_FILES.has(name)) out.push(p)
  }
  return out
}

for (const file of walk(src)) {
  const rel = relative(webApp, file).split(sep).join('/')
  const allowed = new Set(allow.filter((e) => e.file === rel).map((e) => e.token))
  const before = readFileSync(file, 'utf8')
  let after
  if (file.endsWith('.css')) {
    after = before.replace(CSS_RE, (m, n, u, imp = '') => {
      if (allowed.has(m)) return m
      counts.css++
      return `font-size: ${calc(factor(n, u)).replace('*', ' * ')}${imp};`
    })
  } else {
    after = before
      .split('\n')
      .map((line) => {
        let hit = false
        line = line.replace(TEXT_RE, (m, n, u) => {
          if (allowed.has(m)) return m
          hit = true
          counts[u === 'px' ? 'textPx' : 'textRem']++
          return `text-[length:${calc(factor(n, u))}]`
        })
        if (hit) {
          line = line.replace(LEADING_RE, (m, n) => {
            counts.leading++
            return `leading-[${calc(factor(n, 'px'))}]`
          })
        }
        if (file.endsWith('.tsx')) {
          line = line.replace(INLINE_RE, (m, a, b) => {
            if (allowed.has(m)) return m
            counts.inline++
            return `fontSize: '${calc(factor(a ?? b, 'px')).replace('*', ' * ')}'`
          })
        }
        return line
      })
      .join('\n')
  }
  if (after !== before) {
    counts.files++
    if (!check) writeFileSync(file, after)
  }
}

console.log(
  `${check ? 'would convert' : 'converted'}: text-[px] ${counts.textPx}, text-[rem] ${counts.textRem}, ` +
    `leading-[px] ${counts.leading}, inline fontSize ${counts.inline}, css font-size ${counts.css} ` +
    `in ${counts.files} files`
)
if (check && counts.files) process.exit(1)
