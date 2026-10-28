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

// Files that already held raw NULs when this guard landed; they should move to
// the unicode escape too, then leave this list.
const KNOWN = [
  'containers/__tests__/CoworkCodePanel.test.tsx',
  'lib/audio-sentinel.ts',
  'lib/boundedRead.ts',
  'lib/contextLimitRecovery.ts',
  'lib/coworkReadiness.ts',
  'lib/redactToolOutput.ts',
]

describe('source hygiene', () => {
  it('no source file contains a NUL byte', () => {
    // A raw NUL makes git treat the file as binary (no diffs, no blame).
    const bad = walk(SRC)
      .filter((f) => readFileSync(f).includes(0))
      .map((f) => f.slice(SRC.length + 1).split('\\').join('/'))
      .filter((f) => !KNOWN.includes(f))
    expect(bad).toEqual([])
  })
})
