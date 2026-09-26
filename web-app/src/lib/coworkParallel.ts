/**
 * Decisions and backend calls behind parallel sessions on one folder: when a
 * session is put in its own worktree automatically, and the "Work on a copy"
 * lifecycle for folders that are not Git repositories.
 */
import { invoke } from '@tauri-apps/api/core'
import type { AutoState } from '@/hooks/useCoworkParallel'
import {
  useCoworkWorktrees,
  type WorktreeRecord,
} from '@/hooks/useCoworkWorktrees'
import { getServiceHub } from '@/hooks/useServiceHub'

export type AutoIsolateInput = {
  enabled: boolean
  sessionId: string | null
  folder: string | null
  /** The session's stored access mode. */
  access: string
  /** This session already holds a worktree (or copy) in this renderer. */
  hasWorktree: boolean
  /** The backend can confine a run to a managed worktree. */
  capable: boolean
  capabilityKnown: boolean
  /** Turns in the session so far. */
  turns: number
  /** What the default already did for this session and folder. */
  mark: AutoState | undefined
  /** A run or authorization is in flight for this session. */
  busy: boolean
}

/**
 * What the default should do for a session right now.
 *
 * - `start`: a new session (no turns yet) still on the default access mode.
 * - `resume`: a session the default isolated earlier whose worktree this
 *   renderer no longer holds (after a restart); `ensure` finds the same one.
 * - `none`: anything else. In particular a session the user moved to another
 *   mode, or one that already started working in its folder, is never moved.
 */
export function autoIsolateAction(
  input: AutoIsolateInput
): 'start' | 'resume' | 'none' {
  if (!input.sessionId || !input.folder || input.busy) return 'none'
  if (!input.capabilityKnown || !input.capable) return 'none'
  if (input.hasWorktree) return 'none'
  if (input.mark === 'worktree' || input.mark === 'copy') {
    return input.access === 'managed-worktree' ? 'resume' : 'none'
  }
  if (input.mark === 'skipped') return 'none'
  if (!input.enabled) return 'none'
  if (input.turns > 0) return 'none'
  if (input.access !== 'review-only') return 'none'
  return 'start'
}

/** Whether a title is still the placeholder a session starts with. */
export const isPlaceholderTitle = (title: string | undefined): boolean =>
  !title || /^new session$/i.test(title.trim())

/** The commit message used when merging commits the session's pending work. */
export const sessionCommitMessage = (title: string | undefined): string =>
  isPlaceholderTitle(title) ? 'Work from a Flint session' : title!.trim()

export const isGitRepo = async (folder: string): Promise<boolean> => {
  try {
    return await invoke<boolean>('agent_is_git_repo', { folder })
  } catch {
    return false
  }
}

/** Mirrors the Rust `CopyRecord`. */
export type CopyRecord = {
  path: string
  sourceRoot: string
  createdAt: number
  fileCount: number
}

/** Mirrors the Rust `CopyChange`. */
export type CopyChange = {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  conflict: boolean
}

export type FilePair = {
  original: string | null
  copy: string | null
  binary: boolean
}

export type ApplyOutcome = { applied: string[]; skippedConflicts: string[] }

/**
 * A copy described as a worktree record, so the access derivation, the grant
 * and the run's writable root treat it exactly like a managed worktree.
 */
export const copyAsWorktree = (copy: CopyRecord): WorktreeRecord => ({
  path: copy.path,
  branch: '',
  baseSha: '',
  sourceRoot: copy.sourceRoot,
  identity: { root: copy.sourceRoot, firstCommit: null },
  uncommittedAtCreation: [],
  kind: 'copy',
})

export const copyApi = {
  create: (dataFolder: string, sessionId: string, folder: string) =>
    invoke<CopyRecord>('agent_copy_create', { dataFolder, sessionId, folder }),
  changes: (dataFolder: string, path: string) =>
    invoke<CopyChange[]>('agent_copy_changes', { dataFolder, path }),
  filePair: (dataFolder: string, path: string, file: string) =>
    invoke<FilePair>('agent_copy_file_pair', { dataFolder, path, file }),
  apply: (dataFolder: string, path: string, files: string[], force: boolean) =>
    invoke<ApplyOutcome>('agent_copy_apply', { dataFolder, path, files, force }),
}

/** A plain line diff for the review dialog: enough to see what changed. */
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

export function lineDiff(a: string | null, b: string | null): DiffLine[] {
  const x = a === null ? [] : a.split(/\r?\n/)
  const y = b === null ? [] : b.split(/\r?\n/)
  // LCS table; files over the limit fall back to "all removed, all added".
  if (x.length * y.length > 4_000_000) {
    return [
      ...x.map((text) => ({ kind: 'del' as const, text })),
      ...y.map((text) => ({ kind: 'add' as const, text })),
    ]
  }
  const n = x.length
  const m = y.length
  const t: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  )
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i][j] =
        x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i] })
      i++
      j++
    } else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: 'del', text: x[i++] })
    else out.push({ kind: 'add', text: y[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] })
  while (j < m) out.push({ kind: 'add', text: y[j++] })
  return out
}

/**
 * Remove a deleted session's worktree (or copy), when the user chose to.
 * Forced: the choice was made with the list of what it destroys on screen.
 */
export async function removeSessionWorktree(
  sessionId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const dataFolder =
    (await getServiceHub().app().getJanDataFolder().catch(() => '')) ?? ''
  if (!dataFolder) return { ok: false, reason: 'no data folder' }
  return useCoworkWorktrees.getState().discard(sessionId, dataFolder, true)
}
