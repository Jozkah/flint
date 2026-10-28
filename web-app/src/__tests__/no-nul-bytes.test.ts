import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(fileURLToPath(import.meta.url), '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

describe('source hygiene', () => {
  it('no source file contains a NUL byte', () => {
    // A raw NUL makes git treat the file as binary (no diffs, no blame).
    const bad = walk(SRC).filter((f) => readFileSync(f).includes(0))
    expect(bad).toEqual([])
  })
})
