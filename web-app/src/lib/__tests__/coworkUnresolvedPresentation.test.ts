import { describe, expect, it } from 'vitest'
import { unresolvedForSummary } from '../coworkUnresolvedPresentation'
import type { UnresolvedItem } from '../coworkRunOutcome'

const failed = (tool: string, target: string): UnresolvedItem => ({
  kind: 'failed',
  tool,
  target,
})

describe('unresolvedForSummary', () => {
  it('does not show recovered historical failures after a clean completion', () => {
    expect(
      unresolvedForSummary({
        status: 'completed',
        unresolved: [failed('bash', 'npm install'), failed('git', 'status')],
      })
    ).toEqual([])
  })

  it('keeps the stop reason and only the latest blocker per tool', () => {
    const unresolved: UnresolvedItem[] = [
      { kind: 'stop', reason: 'loop' },
      failed('todo', 'init'),
      failed('bash', 'npm install'),
      failed('bash', 'npm.cmd install'),
      failed('git', 'status'),
      failed('bash', 'node npm-cli.js install'),
    ]

    expect(unresolvedForSummary({ status: 'partial', unresolved })).toEqual([
      { kind: 'stop', reason: 'loop' },
      failed('todo', 'init'),
      failed('git', 'status'),
      failed('bash', 'node npm-cli.js install'),
    ])
  })

  it('does not duplicate failed checks under Unresolved', () => {
    expect(
      unresolvedForSummary({
        status: 'partial',
        unresolved: [
          { kind: 'check-failed', command: 'npm test', exitCode: 1 },
          failed('bash', 'npm install'),
        ],
      })
    ).toEqual([failed('bash', 'npm install')])
  })

  it('caps noisy blocker histories', () => {
    const unresolved: UnresolvedItem[] = [
      failed('read', 'a'),
      failed('write', 'b'),
      failed('git', 'c'),
      failed('bash', 'd'),
    ]
    expect(
      unresolvedForSummary({ status: 'failed', unresolved }, 2)
    ).toEqual([failed('git', 'c'), failed('bash', 'd')])
  })
})
