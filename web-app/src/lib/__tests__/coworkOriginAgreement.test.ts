import { describe, expect, it } from 'vitest'
import {
  baselineFromStatus,
  buildOriginLedger,
  destinationOfOrigin,
  evidenceLimit,
  promptFolderAccess,
  summarizeRun,
  unavailableBaseline,
  type RunOrigins,
} from '@/lib/coworkOrigins'
import { buildCoworkSystemPrompt } from '@/lib/coworkPrompt'
import type { GitStatus } from '@/lib/coworkGit'
import type { ReadinessManifest } from '@/lib/coworkReadiness'

/**
 * One run, described by six surfaces.
 *
 * The prompt, readiness, the Code panel, activity, Changes and the completion
 * summary each used to work out for themselves where a run's changes go. Six
 * derivations of one question is six chances to answer it differently, and the
 * user has no way to tell which one is lying. These tests do not check that
 * each surface is individually correct — their own suites do that. They check
 * that all of them are reading the same snapshot, by making that snapshot the
 * only input and asserting the answers cannot contradict.
 */

const SESSION = 'session-a'
const FOLDER = '/home/dev/obs-forwarder'
const binding = { sessionId: SESSION, folder: FOLDER }

const status = (paths: string[]): GitStatus => ({
  branch: 'main',
  repoRoot: FOLDER,
  files: paths.map((path) => ({
    path,
    origPath: null,
    status: 'modified' as const,
    staged: false,
    unstaged: true,
    additions: 1,
    deletions: 0,
    binary: false,
  })),
  additions: paths.length,
  deletions: 0,
})

const editing: RunOrigins = {
  binding,
  access: 'edit-folder',
  destination: 'repository',
  tree: FOLDER,
  baseline: baselineFromStatus(status(['theirs.ts']), binding),
}

const reviewing: RunOrigins = {
  binding,
  access: 'review-only',
  destination: 'sandbox',
  tree: FOLDER,
  baseline: baselineFromStatus(status([]), binding),
}

/** What each surface says, derived from one snapshot and nothing else. */
const describeRun = (origins: RunOrigins) => {
  const entries = buildOriginLedger({
    baseline: origins.baseline,
    janCalls: [{ path: 'mine.ts', destination: origins.destination, ok: true }],
    endDifferences: ['theirs.ts', 'built.js'],
    destinationOf: () => destinationOfOrigin('project', origins.destination),
  })

  const readiness: Pick<ReadinessManifest, 'writeDestination' | 'evidence'> = {
    writeDestination:
      origins.destination === 'external' ? 'sandbox' : origins.destination,
    evidence: evidenceLimit(origins.baseline),
  }

  const prompt = buildCoworkSystemPrompt({
    workspacePath: '/jan/sessions/a',
    // The tree the run works in, which is what the model is told about.
    readOnlyFolder: origins.tree ?? origins.binding.folder,
    folderAccess: promptFolderAccess(origins),
    planMode: false,
    bashAvailable: true,
    subagentNames: [],
    webSearch: false,
  })

  return {
    prompt,
    readiness,
    entries,
    summary: summarizeRun(entries, origins.baseline),
  }
}

describe('every surface describing the same run', () => {
  it('agrees on where an authorized run writes', () => {
    const { prompt, readiness, entries, summary } = describeRun(editing)

    expect(readiness.writeDestination).toBe('repository')
    // The prompt has to say the same thing the gate will do.
    expect(prompt).toContain(FOLDER)
    expect(promptFolderAccess(editing)).toBe('editable')
    expect(entries.find((one) => one.path === 'mine.ts')?.destination).toBe(
      'repository'
    )
    expect(summary.janWrites).toEqual([
      { destination: 'repository', paths: ['mine.ts'] },
    ])
  })

  it('agrees a review-only run reaches nothing outside the sandbox', () => {
    const { readiness, entries, summary } = describeRun(reviewing)

    expect(promptFolderAccess(reviewing)).toBe('read-only')
    expect(readiness.writeDestination).toBe('sandbox')
    expect(entries.every((one) => one.destination !== 'repository')).toBe(true)
    expect(
      summary.janWrites.every((group) => group.destination !== 'repository')
    ).toBe(true)
  })

  it('agrees a managed run works in its worktree, and may write it', () => {
    const WORKTREE = '/jan/worktrees/abc/s1'
    const managed: RunOrigins = {
      binding,
      access: 'managed-worktree',
      destination: 'managed',
      // The distinction the whole field exists for: the session is attached
      // to one tree and changing another.
      tree: WORKTREE,
      baseline: baselineFromStatus(status([]), binding),
    }
    const { prompt, readiness, entries } = describeRun(managed)

    expect(readiness.writeDestination).toBe('managed')
    // Editable, because it is: telling the model otherwise would have it
    // spend the run proposing changes it could have made.
    expect(promptFolderAccess(managed)).toBe('editable')
    // And the tree it is told about is the worktree, not the checkout it must
    // not touch.
    expect(prompt).toContain(WORKTREE)
    expect(prompt).not.toContain(FOLDER)
    expect(entries.find((one) => one.path === 'mine.ts')?.destination).toBe(
      'managed'
    )
    // And the completion summary names which worktree, because "in the
    // worktree" is true of a specific one.
    expect(summarizeRun(entries, managed.baseline, managed).tree).toBe(WORKTREE)
  })

  it('does not name a tree when the changes are in the attached folder', () => {
    const { entries } = describeRun(editing)
    expect(summarizeRun(entries, editing.baseline, editing).tree).toBeNull()
  })

  it('says read-only for a managed session whose worktree is gone', () => {
    // Same doubling as the direct-edit case: the access remembers the mode,
    // the destination reports what would happen, and only agreement is
    // editable.
    expect(
      promptFolderAccess({
        binding,
        access: 'managed-worktree',
        destination: 'sandbox',
        tree: FOLDER,
        baseline: null,
      })
    ).toBe('read-only')
  })

  /**
   * The failure this prevents: a session that remembers "edit this folder" but
   * holds no live grant. The gate writes to the sandbox; if the prompt still
   * says the folder is editable, the model spends the run attempting writes
   * that are refused and reports work it did not do.
   */
  it('tells the model read-only when the grant is gone, whatever was preferred', () => {
    const remembered: RunOrigins = {
      ...editing,
      access: 'edit-folder',
      destination: 'sandbox',
    }

    expect(promptFolderAccess(remembered)).toBe('read-only')
  })

  it('agrees on what cannot be attributed at all', () => {
    const noEvidence: RunOrigins = {
      ...editing,
      baseline: unavailableBaseline(binding),
    }
    const { readiness, entries, summary } = describeRun(noEvidence)

    expect(readiness.evidence).toBe('git-unavailable')
    // Readiness warned before the run; the summary says the same afterwards.
    expect(summary.baseline).toBe('git-unavailable')
    expect(
      entries
        .filter((one) => one.evidence !== 'jan-write')
        .every((one) => one.evidence === 'no-evidence')
    ).toBe(true)
    expect(summary.unknown).toEqual(['theirs.ts', 'built.js'])
  })

  it('agrees on what is not Jan’s, before and after', () => {
    const { readiness, entries, summary } = describeRun(editing)

    expect(readiness.evidence).toBe('none')
    expect(entries.find((one) => one.path === 'theirs.ts')?.evidence).toBe(
      'pre-existing'
    )
    expect(summary.preExisting).toEqual(['theirs.ts'])
    expect(summary.observed).toEqual(['built.js'])
    // Whatever the surface, the file Jan did not touch is never in its writes.
    expect(summary.janWrites.flatMap((group) => group.paths)).not.toContain(
      'theirs.ts'
    )
  })

  // The snapshot is the run's, not the session's current state: this is what
  // makes withdrawing access afterwards unable to relabel what happened.
  it('is unchanged by anything the session does later', () => {
    const first = describeRun(editing)
    const second = describeRun(editing)

    expect(second.entries).toEqual(first.entries)
    expect(second.summary).toEqual(first.summary)
  })
})
