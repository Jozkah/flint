import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { invoke } from '@tauri-apps/api/core'
import { backendStorage } from '@/lib/backendStorage'
import { localStorageKey } from '@/constants/localStorage'
import { errorText } from '@/lib/errorText'

/**
 * Points a session can be taken back to.
 *
 * The snapshots themselves are Git objects off to one side of the user's
 * branch, so what is kept here is the chain that makes them findable again —
 * which is worth persisting precisely because the objects outlive the process
 * that wrote them. A crash mid-run leaves the work *and* the way back to it;
 * forgetting the chain would leave only the work.
 *
 * Two things are recorded with each point, and neither is decoration.
 *
 * **The tree it was taken in.** A checkpoint is only offered when the session
 * is still working in that tree: a session that has moved to another folder,
 * or whose worktree is gone, must not be offered a rewind that would resolve
 * against something else.
 *
 * **Whose tree it is.** That is what decides whether rewinding may discard
 * anything, and it is decided when the checkpoint is taken rather than by
 * whoever is asking at rewind time. Authority is not stored: a grant is not
 * restorable, and a checkpoint taken while a session could write is not
 * permission to write now.
 */

/** Mirrors the Rust `Destination`. */
export type CheckpointDestination = 'managed' | 'user-checkout'

/** Mirrors the Rust `Checkpoint`. */
export type Checkpoint = {
  sha: string
  label: string
  destination: CheckpointDestination
  /** The tree it describes. */
  root: string
}

/** One entry in a session's chain, with when it happened. */
export type CheckpointEntry = Checkpoint & {
  at: number
  /**
   * The access mode in force when it was taken.
   *
   * Shown, never acted on: it explains why a point is a restore or a patch. A
   * rewind's authority comes from `destination` and from what the backend will
   * agree to do, never from this.
   */
  access: string
}

/** Mirrors the Rust `RewindPlan`. */
export type RewindPlan =
  | { kind: 'restore'; sha: string }
  | { kind: 'patch'; diff: string }

type CheckpointsState = {
  /** By session id, oldest first. */
  bySession: Record<string, CheckpointEntry[]>

  capture: (input: {
    sessionId: string
    root: string
    label: string
    changed: string[]
    destination: CheckpointDestination
    access: string
  }) => Promise<CheckpointEntry | null>
  /** What rewinding to this point would do. Nothing is changed. */
  plan: (
    sessionId: string,
    sha: string
  ) => Promise<{ ok: true; plan: RewindPlan } | { ok: false; reason: string }>
  /** Carry out a rewind the backend agrees may discard. */
  restore: (
    sessionId: string,
    sha: string
  ) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** The points still resolvable in `tree`, newest first. */
  usable: (sessionId: string, tree: string | null) => CheckpointEntry[]
  /** Drop a session's chain, in Git and here. */
  forget: (sessionId: string) => Promise<void>
}

/** Shared so a rejected Tauri command never renders as `[object Object]`. */
const messageOf = errorText

export const useCoworkCheckpoints = create<CheckpointsState>()(
  persist(
    (set, get) => ({
      bySession: {},

      capture: async (input) => {
        const chain = get().bySession[input.sessionId] ?? []
        // Chained to the previous point in the same tree, so the history reads
        // as one line of work rather than a set of unrelated snapshots.
        const parent = [...chain]
          .reverse()
          .find((one) => one.root === input.root)?.sha
        try {
          const made = await invoke<Checkpoint>('agent_checkpoint_capture', {
            root: input.root,
            threadId: input.sessionId,
            parent: parent ?? null,
            label: input.label,
            changed: input.changed,
            destination: input.destination,
          })
          const entry: CheckpointEntry = {
            ...made,
            at: Date.now(),
            access: input.access,
          }
          set((s) => ({
            bySession: {
              ...s.bySession,
              [input.sessionId]: [...chain, entry],
            },
          }))
          return entry
        } catch {
          // A checkpoint that could not be taken is not a run that should
          // stop: the run is what the user asked for, and the absence of a way
          // back is reported by the list being empty rather than by a failure
          // here.
          return null
        }
      },

      plan: async (sessionId, sha) => {
        const chain = get().bySession[sessionId] ?? []
        const target = chain.find((one) => one.sha === sha)
        if (!target) return { ok: false, reason: 'that point is not recorded' }
        const latest = chain[chain.length - 1]?.sha ?? sha
        try {
          return {
            ok: true,
            plan: await invoke<RewindPlan>('agent_checkpoint_plan', {
              checkpoint: {
                sha: target.sha,
                label: target.label,
                destination: target.destination,
                root: target.root,
              },
              latest,
            }),
          }
        } catch (e) {
          return { ok: false, reason: messageOf(e) }
        }
      },

      restore: async (sessionId, sha) => {
        const chain = get().bySession[sessionId] ?? []
        const target = chain.find((one) => one.sha === sha)
        if (!target) return { ok: false, reason: 'that point is not recorded' }
        const latest = chain[chain.length - 1]?.sha ?? sha
        try {
          await invoke('agent_checkpoint_restore', {
            checkpoint: {
              sha: target.sha,
              label: target.label,
              destination: target.destination,
              root: target.root,
            },
            latest,
          })
        } catch (e) {
          return { ok: false, reason: messageOf(e) }
        }
        // Everything after the restored point describes a tree that no longer
        // exists. Keeping those entries would offer a way "forward" that
        // resolves against nothing.
        const at = chain.findIndex((one) => one.sha === sha)
        set((s) => ({
          bySession: {
            ...s.bySession,
            [sessionId]: chain.slice(0, at + 1),
          },
        }))
        return { ok: true }
      },

      usable: (sessionId, tree) => {
        if (!tree) return []
        return [...(get().bySession[sessionId] ?? [])]
          .filter((one) => one.root === tree)
          .reverse()
      },

      forget: async (sessionId) => {
        const chain = get().bySession[sessionId] ?? []
        const roots = [...new Set(chain.map((one) => one.root))]
        for (const root of roots) {
          try {
            await invoke('agent_checkpoint_forget', {
              root,
              threadId: sessionId,
            })
          } catch {
            // Git's own bookkeeping is best-effort here; what matters is that
            // this session stops offering points it will not honour.
          }
        }
        set((s) => {
          const next = { ...s.bySession }
          delete next[sessionId]
          return { bySession: next }
        })
      },
    }),
    {
      name: localStorageKey.coworkCheckpoints,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      version: 1,
    }
  )
)
