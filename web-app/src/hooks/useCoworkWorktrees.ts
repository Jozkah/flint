import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { errorText } from '@/lib/errorText'
import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * The Flint-owned worktrees this renderer knows about.
 *
 * Not persisted, for the same reason grants are not: the record describes
 * something on disk, and a record restored from storage would assert a worktree
 * exists without anyone having looked. Every session re-resolves through
 * `ensure`, which is idempotent — it finds the worktree that is already there
 * rather than making a second one — so nothing is lost by starting empty and a
 * stale claim becomes impossible.
 */

/** Mirrors the Rust `RepoIdentity`. */
export type RepoIdentity = {
  root: string
  firstCommit: string | null
}

/** Mirrors the Rust `WorktreeRecord`. */
export type WorktreeRecord = {
  path: string
  branch: string
  baseSha: string
  sourceRoot: string
  identity: RepoIdentity
  /**
   * What the source had uncommitted when this was created, and which the run
   * therefore cannot see. Surfaced so it is said before the work, not
   * discovered after it.
   */
  uncommittedAtCreation: string[]
  /** The branch it was based on, and the one "Merge" targets. */
  baseBranch?: string | null
  /**
   * What the source checkout held that the worktree does not carry -- a
   * rebase or merge in progress. Said, not refused.
   */
  notes?: string[]
  /**
   * `copy` for a plain folder's "Work on a copy": not a Git worktree, so the
   * Git health check does not apply and there is no branch.
   */
  kind?: 'worktree' | 'copy'
}

/** Mirrors the Rust `MergeOutcome`. */
export type MergeOutcome = {
  merged: boolean
  fastForward: boolean
  alreadyMerged: boolean
  target: string
  newTip: string | null
  conflicts: string[]
  committedPending: boolean
}

export type EnsureOptions = { title?: string; base?: string }

/** Mirrors the Rust `WorktreeState`. */
export type WorktreeState =
  | 'ready'
  | 'missing'
  | 'corrupt'
  | 'branch-moved'
  | 'identity-changed'

export type EnsureOutcome =
  | { ok: true; record: WorktreeRecord }
  | { ok: false; reason: string }

type WorktreesState = {
  /** By session id. */
  bySession: Record<string, WorktreeRecord>
  /** The last failure per session, so the UI can say why there is nothing. */
  errorBySession: Record<string, string>

  ensure: (
    sessionId: string,
    project: string,
    dataFolder: string,
    options?: EnsureOptions
  ) => Promise<EnsureOutcome>
  /**
   * Merge a session's branch into its base branch. Uncommitted work in the
   * worktree is committed first only when `commitMessage` is given.
   */
  merge: (
    sessionId: string,
    dataFolder: string,
    commitMessage?: string
  ) => Promise<{ ok: true; outcome: MergeOutcome } | { ok: false; reason: string }>
  /** Commits on the session's branch its base does not have. */
  unmerged: (record: WorktreeRecord) => Promise<string[]>
  /** Rename the session's branch after its title. */
  rename: (sessionId: string, dataFolder: string, title: string) => Promise<void>
  check: (sessionId: string) => Promise<WorktreeState | null>
  /**
   * Remove a session's worktree.
   *
   * `force` is what the user chose after being shown [`pending`]. Without it
   * the backend refuses a worktree that holds uncommitted work, so a stray
   * call cannot be the reason a run's output disappeared.
   */
  discard: (
    sessionId: string,
    dataFolder: string,
    force?: boolean
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Apply opt-in optimizations to a session's worktree after it was created.
   *
   * A separate step from `ensure`: narrowing the checkout to `sparsePaths` and
   * sharing heavy directories in `symlinkDirectories` (each a repository-relative
   * path, e.g. `node_modules`) is a choice made here, not part of creating the
   * worktree. The backend validates every path and refuses to overwrite anything
   * already in the worktree, so a bad entry comes back as a reason rather than
   * silently changing the tree.
   */
  optimize: (
    sessionId: string,
    dataFolder: string,
    options: { symlinkDirectories?: string[]; sparsePaths?: string[] }
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** What a worktree holds that removing it would destroy. */
  pending: (record: WorktreeRecord) => Promise<string[]>
  /**
   * Every Flint-owned worktree of this project that is on disk.
   *
   * The recovery surface, and only that: a listed worktree is a place work
   * might be sitting. Nothing here authorizes writing to one — that still
   * takes the user confirming it, exactly as it did the first time.
   */
  list: (project: string, dataFolder: string) => Promise<WorktreeRecord[]>
  /**
   * Bind a session to a worktree that already exists.
   *
   * Local bookkeeping only. Adopting does not make the worktree writable: the
   * access mode still has to be switched, which is what issues a grant.
   */
  adopt: (sessionId: string, record: WorktreeRecord) => void
  recordFor: (
    sessionId: string | null | undefined
  ) => WorktreeRecord | undefined
  forget: (sessionId: string) => void
}

/** Shared so a rejected Tauri command never renders as `[object Object]`. */
const messageOf = errorText

async function dataFolderOf(): Promise<string> {
  return (await getServiceHub().app().getJanDataFolder()) ?? ''
}

export const useCoworkWorktrees = create<WorktreesState>()((set, get) => ({
  bySession: {},
  errorBySession: {},

  ensure: async (sessionId, project, dataFolder, options) => {
    try {
      const record = await invoke<WorktreeRecord>('agent_worktree_ensure', {
        dataFolder,
        sessionId,
        project,
        title: options?.title ?? null,
        base: options?.base ?? null,
      })
      set((s) => ({
        bySession: { ...s.bySession, [sessionId]: record },
        errorBySession: { ...s.errorBySession, [sessionId]: '' },
      }))
      return { ok: true, record }
    } catch (e) {
      const reason = messageOf(e)
      // Kept rather than swallowed: every refusal from the backend names
      // something that happened outside Flint — a branch someone else made, a
      // directory in our place — and the user can only act on what they see.
      set((s) => ({
        errorBySession: { ...s.errorBySession, [sessionId]: reason },
      }))
      return { ok: false, reason }
    }
  },

  merge: async (sessionId, dataFolder, commitMessage) => {
    const record = get().bySession[sessionId]
    if (!record || record.kind === 'copy')
      return { ok: false, reason: 'no worktree for this session' }
    try {
      const outcome = await invoke<MergeOutcome>('agent_worktree_merge', {
        dataFolder,
        record,
        target: null,
        commitMessage: commitMessage ?? null,
      })
      return { ok: true, outcome }
    } catch (e) {
      return { ok: false, reason: messageOf(e) }
    }
  },

  unmerged: async (record) => {
    if (record.kind === 'copy') return []
    try {
      return await invoke<string[]>('agent_worktree_unmerged', { record })
    } catch {
      return ['(could not be listed)']
    }
  },

  rename: async (sessionId, dataFolder, title) => {
    const record = get().bySession[sessionId]
    if (!record || record.kind === 'copy') return
    try {
      const next = await invoke<WorktreeRecord>('agent_worktree_rename', {
        dataFolder,
        record,
        sessionId,
        title,
      })
      // Keep what only the renderer knew (notes, base) on the renamed record.
      set((s) =>
        s.bySession[sessionId]
          ? {
              bySession: {
                ...s.bySession,
                [sessionId]: { ...s.bySession[sessionId], branch: next.branch },
              },
            }
          : s
      )
    } catch {
      // A rename is cosmetic; the branch keeps its first name.
    }
  },

  check: async (sessionId) => {
    const record = get().bySession[sessionId]
    if (!record) return null
    if (record.kind === 'copy') {
      try {
        await invoke('agent_copy_changes', {
          dataFolder: await dataFolderOf(),
          path: record.path,
        })
        return 'ready'
      } catch {
        return 'missing'
      }
    }
    try {
      return await invoke<WorktreeState>('agent_worktree_state', { record })
    } catch {
      // An unanswerable question is not a healthy worktree.
      return 'corrupt'
    }
  },

  discard: async (sessionId, dataFolder, force = false) => {
    const record = get().bySession[sessionId]
    if (!record) return { ok: true }
    try {
      if (record.kind === 'copy')
        await invoke('agent_copy_discard', {
          dataFolder,
          path: record.path,
          force,
        })
      else await invoke('agent_worktree_discard', { dataFolder, record, force })
    } catch (e) {
      // The refusal names what would have been destroyed, and that is the
      // whole value of it: a caller that only learned "it failed" would have
      // nothing to put in front of the user.
      return { ok: false, reason: messageOf(e) }
    }
    set((s) => {
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    })
    return { ok: true }
  },

  optimize: async (sessionId, dataFolder, options) => {
    const record = get().bySession[sessionId]
    if (!record) return { ok: false, reason: 'no worktree for this session' }
    try {
      await invoke('agent_worktree_optimize', {
        dataFolder,
        record,
        symlinkDirectories: options.symlinkDirectories ?? [],
        sparsePaths: options.sparsePaths ?? [],
      })
      return { ok: true }
    } catch (e) {
      // The refusal names what the backend would not do — a path that climbed
      // out, an entry that already existed — so the user can act on it.
      return { ok: false, reason: messageOf(e) }
    }
  },

  pending: async (record) => {
    if (record.kind === 'copy') {
      try {
        const changes = await invoke<{ path: string }[]>('agent_copy_changes', {
          dataFolder: await dataFolderOf(),
          path: record.path,
        })
        return changes.map((c) => c.path)
      } catch {
        return ['(could not be listed)']
      }
    }
    try {
      return await invoke<string[]>('agent_worktree_pending', { record })
    } catch {
      // An unanswerable question is not "nothing to lose". Reporting empty
      // here would turn a failed check into a silent forced removal.
      return ['(could not be listed)']
    }
  },

  list: async (project, dataFolder) => {
    try {
      return await invoke<WorktreeRecord[]>('agent_worktree_list', {
        dataFolder,
        project,
      })
    } catch {
      return []
    }
  },

  adopt: (sessionId, record) =>
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: record },
      errorBySession: { ...s.errorBySession, [sessionId]: '' },
    })),

  recordFor: (sessionId) =>
    sessionId ? get().bySession[sessionId] : undefined,

  forget: (sessionId) =>
    set((s) => {
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    }),
}))
