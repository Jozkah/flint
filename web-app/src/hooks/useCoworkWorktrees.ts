import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { errorText } from '@/lib/errorText'

/**
 * The Jan-owned worktrees this renderer knows about.
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
}

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
    dataFolder: string
  ) => Promise<EnsureOutcome>
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
  /** What a worktree holds that removing it would destroy. */
  pending: (record: WorktreeRecord) => Promise<string[]>
  /**
   * Every Jan-owned worktree of this project that is on disk.
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

export const useCoworkWorktrees = create<WorktreesState>()((set, get) => ({
  bySession: {},
  errorBySession: {},

  ensure: async (sessionId, project, dataFolder) => {
    try {
      const record = await invoke<WorktreeRecord>('agent_worktree_ensure', {
        dataFolder,
        sessionId,
        project,
      })
      set((s) => ({
        bySession: { ...s.bySession, [sessionId]: record },
        errorBySession: { ...s.errorBySession, [sessionId]: '' },
      }))
      return { ok: true, record }
    } catch (e) {
      const reason = messageOf(e)
      // Kept rather than swallowed: every refusal from the backend names
      // something that happened outside Jan — a branch someone else made, a
      // directory in our place — and the user can only act on what they see.
      set((s) => ({
        errorBySession: { ...s.errorBySession, [sessionId]: reason },
      }))
      return { ok: false, reason }
    }
  },

  check: async (sessionId) => {
    const record = get().bySession[sessionId]
    if (!record) return null
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
      await invoke('agent_worktree_discard', { dataFolder, record, force })
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

  pending: async (record) => {
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
