import { describe, expect, it } from 'vitest'
import {
  conflictFilesOf,
  paneMarkOf,
  taskActionsOf,
  taskCheckOf,
  wordOf,
} from '@/lib/campaignView'
import { mergeTaskDiffs } from '@/lib/campaignDiff'

describe('paneMarkOf', () => {
  const idle = { needsApproval: false, streaming: false }
  it('shows done only for an earned finish and error for failures', () => {
    expect(paneMarkOf({ ...idle })).toBe('none')
    expect(paneMarkOf({ ...idle, task: { status: 'merged' } })).toBe('done')
    expect(paneMarkOf({ ...idle, task: { status: 'failed' } })).toBe('error')
    expect(paneMarkOf({ ...idle, task: { status: 'running' } })).toBe('none')
    expect(paneMarkOf({ ...idle, ending: { stoppedBy: 'done' } })).toBe('done')
    expect(paneMarkOf({ ...idle, ending: { stoppedBy: 'error' } })).toBe('error')
    expect(paneMarkOf({ ...idle, ending: { stoppedBy: 'aborted' } })).toBe('none')
    expect(
      paneMarkOf({ needsApproval: true, streaming: true, task: { status: 'merged' } })
    ).toBe('approval')
  })
})

describe('conflict and check', () => {
  it('reads conflict files from the resolver record or the detail', () => {
    expect(conflictFilesOf({ resolver: { files: ['a.ts'] } })).toEqual(['a.ts'])
    expect(
      conflictFilesOf({ detail: 'merge conflict in: src/a.ts, src/b.ts' })
    ).toEqual(['src/a.ts', 'src/b.ts'])
    expect(conflictFilesOf({ detail: 'failed' })).toEqual([])
  })
  it('offers resolve only in conflict and names the resolving word', () => {
    expect(taskActionsOf({ status: 'conflict', attempt: 0 }).resolve).toBe(true)
    expect(taskActionsOf({ status: 'failed', attempt: 0 }).resolve).toBe(false)
    expect(
      wordOf({ status: 'resolving', dependsOn: [] } as never).word
    ).toBe('resolving')
  })
  it('reads the objective check and verifier tokens', () => {
    const c = taskCheckOf({
      verifyTokens: 120,
      evidence: { check: { passed: false, output: 'a\nb\nFAILED x' } },
    })
    expect(c).toMatchObject({ passed: false, tokens: 120 })
    expect(c?.tail).toContain('FAILED x')
    expect(taskCheckOf({})).toBeNull()
  })
})

describe('mergeTaskDiffs', () => {
  it('lists a shared file once with both counts', () => {
    const f = (path: string, added: number) => ({
      path,
      status: 'modified' as const,
      added,
      removed: 0,
      binary: false,
      truncated: false,
    })
    const out = mergeTaskDiffs([
      { files: [f('a', 2), f('b', 1)], added: 3, removed: 0, truncated: false, uncommitted: false },
      { files: [f('a', 4)], added: 4, removed: 0, truncated: false, uncommitted: true },
    ])
    expect(out.files.map((x) => [x.path, x.added])).toEqual([['a', 6], ['b', 1]])
    expect(out.added).toBe(7)
    expect(out.uncommitted).toBe(true)
  })
})
