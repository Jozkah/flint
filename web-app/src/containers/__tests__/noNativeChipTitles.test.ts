/**
 * Chips name things (a mention, a file, a model) and must not carry a native
 * `title` tooltip: it duplicates the accessible name, cannot be styled, and
 * pops up late over the chip. Use aria-label, or the app's Tooltip component.
 * This scans every container for JSX elements that look like chips and fail
 * on a `title=` prop. Existing legitimate uses go in ALLOW with a reason.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')

/** file (relative to containers/) -> why its chip title is fine. */
const ALLOW: Record<string, string> = {}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : files(p)
    return p.endsWith('.tsx') ? [p] : []
  })
}

/** Every JSX opening tag (possibly multi-line) in a source file. */
function openingTags(src: string): { tag: string; line: number }[] {
  const out: { tag: string; line: number }[] = []
  const re = /<([A-Za-z][\w.]*)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    let i = m.index + m[0].length
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push({
      tag: src.slice(m.index, i + 1),
      line: src.slice(0, m.index).split('\n').length,
    })
  }
  return out
}

/** A chip: the Chip primitive, or an element whose test id says chip. */
const CHIP_TAG = /^<\w*Chip/
const CHIP_ID = /data-testid="[^"]*chip[^"]*"/i
const TITLE = /\stitle=\{/

describe('chips carry no native title tooltips', () => {
  it('finds none outside the allowlist', () => {
    const hits: string[] = []
    for (const file of files(ROOT)) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (ALLOW[rel]) continue
      for (const { tag, line } of openingTags(readFileSync(file, 'utf8'))) {
        // Only the tag's own attributes, not nested JSX in attribute values.
        const own = tag.replace(/\{[^{}]*\}/g, '{}')
        if ((CHIP_TAG.test(tag) || CHIP_ID.test(own)) && TITLE.test(own)) hits.push(`${rel}:${line}`)
      }
    }
    expect(hits).toEqual([])
  })
})
