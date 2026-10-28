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
import { DEFAULT_SESSION_TITLE } from '@/lib/coworkSessionStart'

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
  // A persisted Managed worktree choice is still the session's destination
  // after a restart. Re-resolve its checkout and issue a fresh process-local
  // grant before the next run, including sessions isolated manually.
  if (input.access === 'managed-worktree' && input.mark !== 'copy') return 'resume'
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
  !title || title.trim() === DEFAULT_SESSION_TITLE

/** The commit message used when merging commits the session's pending work. */
export const sessionCommitMessage = (title: string | undefined): string =>
  isPlaceholderTitle(title) ? 'Work from a Flint session' : title!.trim()

/**
 * Whether `folder` is a Git repository. `null` means the check itself failed
 * (backend busy or erroring), which is not the same as "not a repository":
 * callers must not record a failure as a negative answer.
 */
export const isGitRepo = async (folder: string): Promise<boolean | null> => {
  try {
    return await invoke<boolean>('agent_is_git_repo', { folder })
  } catch {
    return null
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
  // Lines both sides share at the start and at the end need no table: the
  // common case (a few edits in a big file) shrinks to the changed middle.
  let head = 0
  const most = Math.min(x.length, y.length)
  while (head < most && x[head] === y[head]) head++
  let tail = 0
  while (tail < most - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  const n = x.length - head - tail
  const m = y.length - head - tail
  const out: DiffLine[] = []
  for (let k = 0; k < head; k++) out.push({ kind: 'same', text: x[k] })
  // LCS table over the middle; past the limit it falls back to "all removed,
  // all added".
  if (n * m > 4_000_000) {
    for (let k = 0; k < n; k++) out.push({ kind: 'del', text: x[head + k] })
    for (let k = 0; k < m; k++) out.push({ kind: 'add', text: y[head + k] })
  } else {
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] =
          x[head + i] === y[head + j]
            ? t[(i + 1) * w + j + 1] + 1
            : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[head + i] === y[head + j]) {
        out.push({ kind: 'same', text: x[head + i] })
        i++
        j++
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ kind: 'del', text: x[head + i++] })
      else out.push({ kind: 'add', text: y[head + j++] })
    }
    while (i < n) out.push({ kind: 'del', text: x[head + i++] })
    while (j < m) out.push({ kind: 'add', text: y[head + j++] })
  }
  for (let k = 0; k < tail; k++) out.push({ kind: 'same', text: x[x.length - tail + k] })
  return out
}

/**
 * Remove a deleted session's worktree (or copy), when the user chose to.
 * Forced by default: the choice was made with the list of what it destroys on
 * screen. Pass `force = false` to have the backend refuse a worktree that
 * holds unfinished work instead.
 */
export async function removeSessionWorktree(
  sessionId: string,
  force = true
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const dataFolder =
    (await getServiceHub().app().getJanDataFolder().catch(() => '')) ?? ''
  if (!dataFolder) return { ok: false, reason: 'no data folder' }
  return useCoworkWorktrees.getState().discard(sessionId, dataFolder, force)
}
