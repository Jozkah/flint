import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Descenders (g j p q y) hang below the baseline. A clipped one-line label
 * (`truncate`, `line-clamp-*`) with `leading-none` has a box shorter than its
 * glyphs, so overflow:hidden cuts them. Such a label must also carry
 * `descender-safe` (padding + equal negative margin; layout unchanged).
 */
const ROOT = join(__dirname, '..')

const walk = (dir: string, out: string[] = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walk(p, out)
    } else if (/\.tsx$/.test(name)) out.push(p)
  }
  return out
}

describe('descender safety', () => {
  const classLiterals = (fn: (file: string, cls: string, tokens: string[]) => void) => {
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, 'utf8')
      // every string literal that holds class names (quotes ' " `)
      for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\n])*?)\1/g)) {
        fn(file.slice(ROOT.length + 1), m[2], m[2].split(/\s+/))
      }
    }
  }
  // line-height at or below the glyph box: leading-none, leading-3, leading-[1],
  // leading-[0.x]. (leading-[15px] on 10.5px text and leading-4 are fine.)
  const tight = (t: string) => /^leading-(none|3|\[1(\.0)?\]|\[0?\.\d+\])$/.test(t)
  const clipped = (t: string) =>
    t === 'truncate' || t === 'overflow-hidden' || t === 'overflow-clip' || t.startsWith('line-clamp-')
  // Known safe: the nav row's label is a text-fade span (padded) in a fixed-height row.
  const SAFE = new Set(['components/shell/nav-kit.tsx'])

  it('no clipped label pairs a tight line-height with truncate or line-clamp unprotected', () => {
    const offenders: string[] = []
    classLiterals((file, cls, tokens) => {
      if (SAFE.has(file.replace(/\\/g, '/'))) return
      if (!tokens.some(tight) || !tokens.some(clipped)) return
      if (tokens.includes('descender-safe') || tokens.includes('text-fade')) return
      offenders.push(`${file}: ${cls.slice(0, 80)}`)
    })
    expect(offenders).toEqual([])
  })

  it('text clipped to its glyphs (bg-clip-text) is descender-safe', () => {
    const offenders: string[] = []
    classLiterals((file, cls, tokens) => {
      if (tokens.includes('bg-clip-text') && !tokens.includes('descender-safe')) offenders.push(`${file}: ${cls.slice(0, 80)}`)
    })
    expect(offenders).toEqual([])
  })

  it('no inline lineHeight of 1 in components', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      if (/lineHeight:\s*['"]?1['"]?\s*[,}]/.test(readFileSync(file, 'utf8'))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('the descender-safe utility pads and pulls back equally', () => {
    const css = readFileSync(join(ROOT, 'index.css'), 'utf8')
    const block = css.match(/@utility descender-safe \{([^}]*)\}/)?.[1] ?? ''
    expect(block).toMatch(/padding-block:\s*0\.2em/)
    expect(block).toMatch(/margin-block:\s*-0\.2em/)
  })

  it('the boot splash caption keeps room for descenders', () => {
    const html = readFileSync(join(ROOT, '..', 'index.html'), 'utf8')
    const rule = html.match(/#initial-loader-caption \{([^}]*)\}/)?.[1] ?? ''
    const lh = Number(rule.match(/line-height:\s*([\d.]+)/)?.[1])
    expect(lh).toBeGreaterThanOrEqual(1.25)
  })

  it('text-fade keeps its descender padding', () => {
    const css = readFileSync(join(ROOT, 'index.css'), 'utf8')
    const block = css.match(/@utility text-fade \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(block).toMatch(/padding-block:\s*0\.2em/)
  })
})
