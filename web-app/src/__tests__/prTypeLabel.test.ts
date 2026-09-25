import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #108: the PR auto-label workflow matched only "feat: x", so the repo's usual
 * "feat(scope): x" and "fix!: x" titles got no label. The mapping lives in
 * .github/scripts/pr-type-label.sh; it is run here through bash, fed on stdin
 * with CRs stripped so a CRLF checkout on Windows runs too.
 */
const HERE = resolve(fileURLToPath(import.meta.url), '..')
const SCRIPT = readFileSync(
  resolve(HERE, '../../../.github/scripts/pr-type-label.sh'),
  'utf8'
).replace(/\r/g, '')
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0

const label = (title: string) =>
  spawnSync('bash', ['-s', title], { input: SCRIPT, encoding: 'utf8' }).stdout.trim()

describe.skipIf(!hasBash)('pr-type-label.sh', () => {
  it.each([
    ['feat: add a thing', 'type: feature request'],
    ['feat(websearch): add You.com', 'type: feature request'],
    ['fix!: drop legacy API', 'type: bug'],
    ['fix(agent-tools)!: rework grants', 'type: bug'],
    ['docs(readme): typo', 'type: documentation'],
    ['build(deps): bump', 'type: ci'],
    ['refactor: tidy', 'type: chore'],
  ])('%s -> %s', (title, expected) => {
    expect(label(title)).toBe(expected)
  })

  it.each(['Merge branch main', 'feature: not a type', 'fixup: nope', 'feat'])(
    'leaves %s unlabelled',
    (title) => {
      expect(label(title)).toBe('')
    }
  )
})
