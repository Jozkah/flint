// Guard: hard-coded font sizes do not follow the Font Size setting. Write
// text-[length:calc(var(--ui-font-base)*N/16)] (or a named size such as
// text-xs) instead, or run scripts/codemods/scale-font-sizes.mjs. A size that
// must stay fixed goes in fixed-font-sizes.allowlist.json with its reason.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import allowlist from './fixed-font-sizes.allowlist.json'

const webApp = join(__dirname, '..', '..')
const src = join(webApp, 'src')
const SKIP_DIRS = new Set(['node_modules', 'mobile', 'locales'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out)
    } else if (/\.(tsx?|css)$/.test(name) && name !== 'routeTree.gen.ts' && !name.includes('.guard.test.')) {
      out.push(p)
    }
  }
  return out
}

describe('font sizes follow the Font Size setting', () => {
  it('has no hard-coded px/rem text size outside the allowlist', () => {
    const offenders: string[] = []
    for (const file of walk(src)) {
      const rel = relative(webApp, file).split(sep).join('/')
      const allowed = new Set(
        allowlist.entries.filter((e) => e.file === rel).map((e) => e.token)
      )
      const re = file.endsWith('.css')
        ? /font-size:\s*\d*\.?\d+(?:px|rem)(?:\s*!important)?;/g
        : /(?<![\w-])text-\[\d*\.?\d+(?:px|rem)\]/g
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.match(re) ?? []) {
            if (!allowed.has(m)) offenders.push(`${rel}:${i + 1} ${m}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })

  it('every allowlist entry has a reason and still exists', () => {
    for (const e of allowlist.entries) {
      expect(e.reason.length).toBeGreaterThan(20)
      expect(readFileSync(join(webApp, e.file), 'utf8')).toContain(e.token)
    }
  })
})
