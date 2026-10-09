import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Regex lookbehind is a parse-time SyntaxError on WebKit older than 16.4
// (macOS Monterey), which takes down the whole bundle. Keep it out of shipped code.
const ROOT = join(__dirname, '..', '..')
const LOOKBEHIND = /\(\?<[=!]/
const COMMENT_LINE = /^\s*(\/\/|\*)/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe('shipped sources', () => {
  it('contain no regex lookbehind', () => {
    const offenders = walk(ROOT).filter((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .some((line) => !COMMENT_LINE.test(line) && LOOKBEHIND.test(line))
    )
    expect(offenders).toEqual([])
  })
})
