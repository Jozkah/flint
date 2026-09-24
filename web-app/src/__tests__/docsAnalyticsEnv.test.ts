import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #106: the docs workflow wrote an unset analytics secret into .env as the
 * word "null", and the docs app embedded it in a GTM script unconditionally.
 * Neither the workflow nor the docs site has a test harness of its own, so
 * both files are checked as text. Paths are resolved from this file.
 */
const HERE = resolve(fileURLToPath(import.meta.url), '..')
const REPO = resolve(HERE, '../../..')
const read = (path: string) => readFileSync(resolve(REPO, path), 'utf8')

describe('docs analytics env', () => {
  it('fills an unset secret as empty, not "null"', () => {
    const workflow = read('.github/workflows/jan-docs.yml')
    expect(workflow).toContain(`'.[$key] // empty'`)
    expect(workflow).not.toMatch(/'\.\[\$key\]'/)
  })

  it('renders the GTM scripts only when a tag id is set', () => {
    const app = read('docs/src/pages/_app.mdx')
    expect(app).toContain("process.env.GTM_ID !== 'null'")
    expect(app).not.toContain('id=${process.env.GTM_ID}')
    expect(app.match(/\{gtmId && \(/g)).toHaveLength(2)
  })
})
