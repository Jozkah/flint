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
 * The branch Flint gives a session's managed worktree: `jan/cowork/` plus the
 * session id's slug. Mirrors `branch_name`/`slug` in the Rust worktree module
 * (first 12 ASCII alphanumerics, then the id's 64-bit FNV-1a hash in hex), so
 * a worktree found after a restart can be recognised as this session's own.
 */
export function sessionWorktreeBranch(sessionId: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(sessionId)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  const head = [...sessionId]
    .filter((c) => /^[A-Za-z0-9]$/.test(c))
    .slice(0, 12)
    .join('')
  return `jan/cowork/${head || 'session'}-${hash.toString(16).padStart(16, '0')}`
}

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

/**
 * The ten hex characters a session's worktree directory is named with.
 * Mirrors `short_id` in the Rust worktree module.
 */
export function sessionShortId(sessionId: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(sessionId)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0').slice(0, 10)
}

/**
 * Which of `sessionIds` a worktree on disk was made for, from its directory
 * name, its titled branch's short-id suffix, or its legacy branch. Undefined
 * when none of them.
 */
export function worktreeOwner(
  record: WorktreeRecord,
  sessionIds: Iterable<string>
): string | undefined {
  const leaf = record.path.split(/[\\/]/).filter(Boolean).pop() ?? ''
  for (const id of sessionIds) {
    const short = sessionShortId(id)
    if (
      leaf === short ||
      record.branch.endsWith(`-${short}`) ||
      record.branch === sessionWorktreeBranch(id)
    )
      return id
  }
  return undefined
}

/**
 * The left-over worktrees worth offering to this session: its own, and ones
 * whose session no longer exists. Another live session's worktree is that
 * session's business, not this one's.
 */
export function recoverableWorktrees(
  found: readonly WorktreeRecord[],
  mine: WorktreeRecord | null | undefined,
  sessionId: string | null | undefined,
  liveSessionIds: readonly string[],
  heldPaths: readonly string[] = []
): WorktreeRecord[] {
  const held = new Set(heldPaths)
  return orphans(found, mine).filter((record) => {
    if (held.has(record.path)) return false
    const owner = worktreeOwner(record, liveSessionIds)
    return owner === undefined || owner === sessionId
  })
}

/** The last two segments of a long path, for a label; the full one goes in a tooltip. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

const HINTS_KEY = 'flint.cowork.worktreeHints'

type Hints = { folders: string[]; notCarried: string[] }

function readHints(): Hints {
  try {
    const raw = JSON.parse(localStorage.getItem(HINTS_KEY) ?? '{}')
    return {
      folders: Array.isArray(raw.folders) ? raw.folders : [],
      notCarried: Array.isArray(raw.notCarried) ? raw.notCarried : [],
    }
  } catch {
    return { folders: [], notCarried: [] }
  }
}

function writeHints(next: Hints): void {
  try {
    localStorage.setItem(HINTS_KEY, JSON.stringify(next))
  } catch {
    // A hint that comes back is not worth failing over.
  }
}

/** The user said not to offer earlier worktrees for this folder again. */
export const recoveryHidden = (folder: string): boolean =>
  readHints().folders.includes(folder)

export function hideRecovery(folder: string): void {
  const hints = readHints()
  if (!hints.folders.includes(folder))
    writeHints({ ...hints, folders: [...hints.folders, folder] })
}

/** The "not carried over" line was dismissed for this session. */
export const notCarriedDismissed = (sessionId: string): boolean =>
  readHints().notCarried.includes(sessionId)

export function dismissNotCarried(sessionId: string): void {
  const hints = readHints()
  if (!hints.notCarried.includes(sessionId))
    writeHints({ ...hints, notCarried: [...hints.notCarried, sessionId] })
}