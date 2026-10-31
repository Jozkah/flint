// Ratchet on hard-coded English in JSX (WI-35 step 3).
//
// Counts literal English text in non-test .tsx files: JSX text nodes and
// string literals on user-visible attributes (placeholder, title, alt,
// aria-label, label). The existing debt lives in jsx-literals-baseline.json
// and never fails; a file whose count grows above its baseline does, so new
// copy goes through t() instead. Burning sites down never fails either: run
//   UPDATE_JSX_LITERALS=1 yarn vitest run src/locales/__tests__/jsxLiterals.test.ts
// to lock a lower count in.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const SRC = resolve(__dirname, '../..')
const BASELINE = join(__dirname, 'jsx-literals-baseline.json')
const ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label'])

/** Text a reader would see as English words: two letters in a row, not code-ish. */
export function isEnglish(text: string): boolean {
  const s = text.replace(/&nbsp;|&[a-z]+;/gi, ' ').trim()
  if (!/[A-Za-z]{2,}/.test(s)) return false
  // Single identifier-like tokens (brand names, units, keys) stay allowed.
  if (/^[\w.\-/:@#%+]+$/.test(s) && !/\s/.test(s) && !/^[A-Z][a-z]+$/.test(s)) return false
  return true
}

/** Literal-English sites in one .tsx source. */
export function countLiterals(source: string, fileName = 'x.tsx'): number {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let n = 0
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && isEnglish(node.text)) n++
    else if (ts.isJsxAttribute(node) && ATTRS.has(node.name.getText(sf))) {
      const init = node.initializer
      const lit =
        init && ts.isStringLiteral(init)
          ? init
          : init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)
            ? init.expression
            : undefined
      if (lit && isEnglish(lit.text)) n++
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

const isTestPath = (rel: string) =>
  /(^|\/)(__tests__|test|dev)(\/|$)|\.(test|spec|stories)\.tsx$/.test(rel)

function* tsxFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* tsxFiles(path)
    else if (name.endsWith('.tsx')) yield path
  }
}

function scan(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of tsxFiles(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/')
    if (isTestPath(rel)) continue
    const n = countLiterals(readFileSync(file, 'utf8'), file)
    if (n > 0) counts[rel] = n
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

describe('literal English in JSX', () => {
  it('detects text nodes and visible attributes only', () => {
    expect(countLiterals('const a = <div>Save changes</div>')).toBe(1)
    expect(countLiterals('const a = <input placeholder="Search models" />')).toBe(1)
    expect(countLiterals('const a = <img alt={"Logo image"} />')).toBe(1)
    expect(countLiterals('const a = <div className="flex gap-2">{t("x")}</div>')).toBe(0)
    expect(countLiterals('const a = <span>GPU</span>')).toBe(0)
    expect(countLiterals('const a = <span>{count} / 10</span>')).toBe(0)
    expect(countLiterals('const a = <span>Cancel</span>')).toBe(1)
  })

  it('no file gains hard-coded English (use t() instead)', () => {
    const counts = scan()
    if (process.env.UPDATE_JSX_LITERALS) {
      writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n')
      return
    }
    const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE, 'utf8'))
    const grown = Object.entries(counts)
      .filter(([f, n]) => n > (baseline[f] ?? 0))
      .map(([f, n]) => `${f}: ${baseline[f] ?? 0} -> ${n}`)
    expect(grown, 'new literal English in JSX; move it to a locale key').toEqual([])
  })
})
