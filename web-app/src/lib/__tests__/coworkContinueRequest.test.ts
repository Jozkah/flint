import { describe, expect, it } from 'vitest'
import { continueRequest, type UnresolvedItem } from '../coworkRunOutcome'

const failed = (tool: string, target: string): UnresolvedItem => ({
  kind: 'failed',
  tool,
  target,
})

describe('continueRequest', () => {
  it('does not tell the next run to replay historical failures', () => {
    const text = continueRequest([
      { kind: 'stop', reason: 'loop' },
      failed('bash', 'npm install'),
      failed('bash', 'npm.cmd install'),
      failed('bash', 'node npm-cli.js install'),
      failed('git', 'checkout feature'),
    ])

    expect(text).toContain('Do not blindly replay failed calls')
    expect(text).not.toContain('npm install\n')
    expect(text).not.toContain('npm.cmd install')
    expect(text).toContain('node npm-cli.js install')
    expect(text).toContain('checkout feature')
    expect(text).toContain('previous run stopped early (loop)')
  })

  it('keeps only one failed check and the latest blocker per tool and target', () => {
    const text = continueRequest([
      failed('read', 'old.ts'),
      failed('read', 'new.ts'),
      failed('read', 'old.ts'),
      { kind: 'check-failed', command: 'npm test old', exitCode: 1 },
      { kind: 'check-failed', command: 'npm test new', exitCode: 1 },
    ])

    // Different files are different blockers; the same file is listed once.
    expect(text).toContain('new.ts')
    expect(text.match(/old\.ts/g)).toHaveLength(1)
    expect(text).not.toContain('npm test old')
    expect(text).toContain('npm test new')
  })

  it('truncates giant command payloads before putting them back in context', () => {
    const text = continueRequest([failed('bash', `npm install ${'x'.repeat(400)}`)])
    expect(text.length).toBeLessThan(800)
    expect(text).toContain('…')
  })

  it('keeps the read-only mode explanation without telling the model to retry it', () => {
    const text = continueRequest([
      {
        kind: 'refused',
        tool: 'write',
        target: 'inventory.py',
        readOnly: true,
      },
    ])
    expect(text).toContain('not offered because the last run was read-only')
    expect(text).not.toContain('retry them')
  })

  it('returns a minimal continuation when there is no blocker evidence', () => {
    expect(continueRequest([])).toBe('Continue.')
  })
})
