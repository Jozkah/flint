/**
 * Making sense of the worktrees Flint left behind.
 *
 * A run's worktree is recorded in memory and nowhere else, deliberately: a
 * record restored from disk would assert that a checkout exists without anyone
 * having looked. The cost of that choice is that a crash — or simply quitting
 * — leaves work in a place nothing points at any more. This is how it is found
 * again.
 *
 * The one rule: **finding work is not regaining access to it.** Everything
 * here deals in paths and branches. No grant is issued, nothing becomes
 * writable, and adopting a worktree only tells this session where it is. The
 * user authorizes it again exactly as they did the first time, or the run
 * writes to its sandbox.
 */

import type { WorktreeRecord } from '@/hooks/useCoworkWorktrees'

/** A worktree nothing in this session is using. */
export type Orphan = {
  record: WorktreeRecord
  /** True when this is the one the current session already holds. */
  mine: boolean
}

/**
 * Sort what is on disk into "this session's" and "left over".
 *
 * Compared by path rather than by branch: the branch is derived from an id, so
 * two records agreeing on it agree because they name the same place, and the
 * place is the thing that matters when deciding what to offer to remove.
 */
export function classify(
  found: readonly WorktreeRecord[],
  mine: WorktreeRecord | null | undefined
): Orphan[] {
  return [...found]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((record) => ({ record, mine: record.path === mine?.path }))
}

/** The ones that are nobody's, in path order. */
export const orphans = (
  found: readonly WorktreeRecord[],
  mine: WorktreeRecord | null | undefined
): WorktreeRecord[] =>
  classify(found, mine)
    .filter((one) => !one.mine)
    .map((one) => one.record)

/**
 * What removing this worktree would destroy, phrased for a confirmation.
 *
 * Never "are you sure": a prompt that does not say what is in the directory is
 * a prompt nobody can answer correctly. An empty list is its own answer, and
 * the caller shows a different, quieter confirmation for it.
 */
export function describePending(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const shown = paths.slice(0, 5).join(', ')
  return paths.length > 5 ? `${shown}, and ${paths.length - 5} more` : shown
}
