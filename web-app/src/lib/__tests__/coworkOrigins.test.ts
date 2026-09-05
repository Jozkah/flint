import { describe, expect, it } from 'vitest'
import {
  acceptBaseline,
  baselineFromStatus,
  buildOriginLedger,
  destinationOfOrigin,
  incompleteBaseline,
  summarizeRun,
  summaryIsEmpty,
  unavailableBaseline,
  type ChangeDestination,
  type GitBaseline,
  type JanFileCall,
} from '@/lib/coworkOrigins'
import type { GitFileEntry, GitStatus } from '@/lib/coworkGit'

const SESSION = 'session-a'
const FOLDER = '/home/dev/obs-forwarder'
const SIBLING = '/home/dev/note-py'
const binding = { sessionId: SESSION, folder: FOLDER }

const file = (over: Partial<GitFileEntry>): GitFileEntry => ({
  path: 'src/a.ts',
  origPath: null,
  status: 'modified',
  staged: false,
  unstaged: true,
  additions: 1,
  deletions: 0,
  binary: false,
  ...over,
})

const status = (files: GitFileEntry[]): GitStatus => ({
  branch: 'main',
  repoRoot: FOLDER,
  files,
  additions: 0,
  deletions: 0,
})

const ledger = (over: {
  baseline?: GitBaseline | null
  janCalls?: JanFileCall[]
  endDifferences?: string[]
  destinationOf?: (path: string) => ChangeDestination
}) =>
  buildOriginLedger({
    // `in`, not `??`: passing no baseline and passing a discarded one are
    // different runs, and only the second has nothing to compare against.
    baseline:
      'baseline' in over
        ? over.baseline
        : baselineFromStatus(status([]), binding),
    janCalls: over.janCalls ?? [],
    endDifferences: over.endDifferences ?? [],
    destinationOf: over.destinationOf ?? (() => 'repository'),
  })

const forPath = (entries: ReturnType<typeof ledger>, path: string) =>
  entries.find((one) => one.path === path)

describe('the state the working tree started in', () => {
  it('is clean when nothing differed', () => {
    expect(baselineFromStatus(status([]), binding).state).toBe('clean')
  })

  it('separates what was staged, modified and never tracked', () => {
    const base = baselineFromStatus(
      status([
        file({ path: 'a.ts' }),
        file({ path: 'b.ts', staged: true }),
        file({ path: 'c.ts', status: 'untracked' }),
      ]),
      binding
    )

    expect(base.state).toBe('dirty')
    expect(base.tracked).toEqual(['a.ts'])
    expect(base.staged).toEqual(['b.ts'])
    expect(base.untracked).toEqual(['c.ts'])
  })

  // Not a failure: there is simply no Git evidence to be had here.
  it('records a folder outside a repository as its own state', () => {
    expect(baselineFromStatus(null, binding).state).toBe('non-git')
  })

  it('keeps Git failing apart from Git having nothing to say', () => {
    expect(unavailableBaseline(binding).state).toBe('git-unavailable')
    expect(incompleteBaseline(binding).state).toBe('incomplete')
  })
})

/**
 * A capture takes a round trip. In that time the user can attach a different
 * folder — and a baseline from the old one would make every file in the new
 * folder look like something this run had just created.
 */
describe('a baseline that arrives for the wrong binding', () => {
  const captured = baselineFromStatus(status([file({ path: 'a.ts' })]), binding)

  it('is kept when the user never moved', () => {
    expect(acceptBaseline(captured, binding)).toBe(captured)
  })

  it.each([
    ['the folder changed', { sessionId: SESSION, folder: SIBLING }],
    ['the folder was detached', { sessionId: SESSION, folder: null }],
    ['the session changed', { sessionId: 'session-b', folder: FOLDER }],
  ])('is discarded when %s', (_name, current) => {
    expect(acceptBaseline(captured, current)).toBeNull()
  })

  // The mutation this prevents: reusing another binding's baseline, which
  // dates every difference in the new folder to this run.
  it('leaves a run with no baseline rather than the wrong one', () => {
    const entries = ledger({
      baseline: acceptBaseline(captured, {
        sessionId: SESSION,
        folder: SIBLING,
      }),
      endDifferences: ['a.ts'],
    })

    expect(forPath(entries, 'a.ts')?.evidence).toBe('no-evidence')
  })
})

describe('what Jan will claim it changed', () => {
  it('claims a file its own successful call wrote', () => {
    const entries = ledger({
      janCalls: [{ path: 'a.ts', destination: 'repository', ok: true }],
    })

    expect(forPath(entries, 'a.ts')).toMatchObject({
      evidence: 'jan-write',
      destination: 'repository',
    })
  })

  it('reports the destination the call actually had', () => {
    const entries = ledger({
      janCalls: [{ path: 'a.ts', destination: 'sandbox', ok: true }],
    })

    expect(forPath(entries, 'a.ts')?.destination).toBe('sandbox')
  })

  // A refused write and a failed write both left the file alone.
  it('claims nothing for a call that did not succeed', () => {
    const entries = ledger({
      janCalls: [{ path: 'a.ts', destination: 'repository', ok: false }],
    })

    expect(entries).toEqual([])
  })

  /**
   * The file was already modified, and Jan then wrote to it. Both are true.
   * Claiming the file outright would present someone else's uncommitted work
   * as Jan's; omitting the write would hide what Jan did.
   */
  it('reports both facts about a write over existing changes', () => {
    const entries = ledger({
      baseline: baselineFromStatus(status([file({ path: 'a.ts' })]), binding),
      janCalls: [{ path: 'a.ts', destination: 'repository', ok: true }],
    })

    expect(forPath(entries, 'a.ts')).toMatchObject({
      evidence: 'jan-write',
      alsoPreExisting: true,
    })
  })
})

describe('what Jan will not claim', () => {
  // The mutation this prevents: treating every end-of-run difference as
  // Jan-authored, which hands the user their own uncommitted work back as
  // something the agent did.
  it('never claims a file that was already dirty', () => {
    const entries = ledger({
      baseline: baselineFromStatus(status([file({ path: 'a.ts' })]), binding),
      endDifferences: ['a.ts'],
    })

    expect(forPath(entries, 'a.ts')?.evidence).toBe('pre-existing')
  })

  // A shell command Jan ran could have done it. So could a build, a watcher,
  // or the user's own editor. The honest report says when it appeared, not
  // who caused it.
  it('says a new difference was observed, not that Jan made it', () => {
    const entries = ledger({ endDifferences: ['a.ts'] })

    expect(forPath(entries, 'a.ts')?.evidence).toBe('observed-in-run')
  })

  it.each(['non-git', 'git-unavailable', 'incomplete'] as const)(
    'knows nothing about differences when the baseline is %s',
    (state) => {
      const entries = ledger({
        baseline: { ...unavailableBaseline(binding), state },
        endDifferences: ['a.ts'],
      })

      expect(forPath(entries, 'a.ts')?.evidence).toBe('no-evidence')
    }
  )

  // Location is not authorship. A file inside the authorized repository is
  // still only a file inside the authorized repository.
  it('does not treat being inside the repository as evidence', () => {
    const entries = ledger({
      endDifferences: ['src/deep/a.ts'],
      destinationOf: () => 'repository',
    })

    expect(forPath(entries, 'src/deep/a.ts')).toMatchObject({
      destination: 'repository',
      evidence: 'observed-in-run',
    })
  })

  it('reports each file once, with its strongest evidence', () => {
    const entries = ledger({
      janCalls: [{ path: 'a.ts', destination: 'repository', ok: true }],
      endDifferences: ['a.ts'],
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].evidence).toBe('jan-write')
  })
})

describe('where a Jan write landed', () => {
  // Jan's own space, whichever part of it.
  it.each(['sandbox', 'artifact'] as const)(
    'reports %s as the session workspace',
    (origin) => {
      expect(destinationOfOrigin(origin, 'repository')).toBe('sandbox')
    }
  )

  // The run's answer, not the path's: a project path under a review-only run
  // was never written, and one under an authorized run went to the folder.
  it.each([
    ['repository', 'repository'],
    ['sandbox', 'sandbox'],
  ] as const)(
    'reports a project path as the run destination %s',
    (runDestination, expected) => {
      expect(destinationOfOrigin('project', runDestination)).toBe(expected)
    }
  )

  it('reports a path outside both roots as external', () => {
    expect(destinationOfOrigin('external', 'repository')).toBe('external')
  })
})

describe('the summary the application writes', () => {
  const base = baselineFromStatus(status([file({ path: 'old.ts' })]), binding)
  const entries = ledger({
    baseline: base,
    janCalls: [
      { path: 'a.ts', destination: 'repository', ok: true },
      { path: 'note.md', destination: 'sandbox', ok: true },
      { path: 'old.ts', destination: 'repository', ok: true },
      { path: 'refused.ts', destination: 'repository', ok: false },
    ],
    endDifferences: ['old.ts', 'built.js'],
  })

  it('counts each kind of evidence separately', () => {
    const summary = summarizeRun(entries, base)

    expect(summary.janWrites).toEqual([
      { destination: 'repository', paths: ['a.ts', 'old.ts'] },
      { destination: 'sandbox', paths: ['note.md'] },
    ])
    expect(summary.janWritesOverExisting).toEqual(['old.ts'])
    expect(summary.observed).toEqual(['built.js'])
    expect(summary.preExisting).toEqual([])
  })

  it('carries the baseline state, so the reader can judge the rest', () => {
    expect(summarizeRun(entries, base).baseline).toBe('dirty')
    expect(summarizeRun([], null).baseline).toBe('none')
  })

  it('is empty when the run changed nothing', () => {
    expect(summaryIsEmpty(summarizeRun([], base))).toBe(true)
    expect(summaryIsEmpty(summarizeRun(entries, base))).toBe(false)
  })

  // Same ledger in, same summary out: nothing here is written by a model.
  it('is the same every time for the same ledger', () => {
    expect(summarizeRun(entries, base)).toEqual(summarizeRun(entries, base))
  })
})
