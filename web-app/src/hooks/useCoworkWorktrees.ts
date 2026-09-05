import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

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
  discard: (sessionId: string) => Promise<boolean>
  recordFor: (sessionId: string | null | undefined) => WorktreeRecord | undefined
  forget: (sessionId: string) => void
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

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

  discard: async (sessionId) => {
    const record = get().bySession[sessionId]
    if (!record) return true
    try {
      await invoke('agent_worktree_discard', { record })
    } catch {
      return false
    }
    set((s) => {
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    })
    return true
  },

  recordFor: (sessionId) => (sessionId ? get().bySession[sessionId] : undefined),

  forget: (sessionId) =>
    set((s) => {
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    }),
}))
