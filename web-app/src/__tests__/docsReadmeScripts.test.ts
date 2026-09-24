import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #116: docs/README.md told contributors to run `yarn deploy`, which the docs
 * package never had, and to look for output in `build/`. Every `yarn <name>`
 * the README shows in a code block must be a script of docs/package.json.
 * Paths are resolved from this file.
 */
const HERE = resolve(fileURLToPath(import.meta.url), '..')
const DOCS = resolve(HERE, '../../../docs')
const readme = readFileSync(resolve(DOCS, 'README.md'), 'utf8')
const scripts = Object.keys(
  JSON.parse(readFileSync(resolve(DOCS, 'package.json'), 'utf8')).scripts ?? {}
)
const BUILTIN = new Set(['install'])

const commands = [...readme.matchAll(/```(?:bash|sh)?\r?\n([\s\S]*?)```/g)]
  .flatMap((m) => m[1].split(/\r?\n/))
  .flatMap((line) => [...line.matchAll(/\byarn\s+([\w:-]+)/g)].map((m) => m[1]))

describe('docs/README.md', () => {
  it('shows yarn commands at all', () => {
    expect(commands.length).toBeGreaterThan(0)
  })

  it.each(commands)('`yarn %s` is a docs script', (name) => {
    expect(BUILTIN.has(name) || scripts.includes(name)).toBe(true)
  })

  it('names the static export directory', () => {
    expect(readme).toContain('`out` directory')
    expect(readme).not.toContain('`build` directory')
  })
})
