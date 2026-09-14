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
  /**
   * Taken immediately before a restore, of the state that restore replaced.
   *
   * Kept when the restore succeeds, which is what makes a restore itself
   * undoable: going back to this point puts the overwritten state back.
   */
  safety?: boolean
}

/** Mirrors the Rust `RewindPlan`. */
export type RewindPlan =
  | {
      kind: 'restore'
      sha: string
      /**
       * Every path the restore would change. Absent from a backend that
       * predates it, in which case the scope cannot be listed.
       */
      files?: string[]
      /** Paths that differ from the state the tree was last known to be in. */
      changedSinceLatest?: string[]
    }
  | { kind: 'patch'; diff: string }

type CaptureInput = {
  sessionId: string
  root: string
  label: string
  changed: string[]
  destination: CheckpointDestination
  access: string
}

type CaptureResult =
  | { ok: true; entry: CheckpointEntry }
  | { ok: false; reason: string }

type CheckpointsState = {
  /** By session id, oldest first. */
  bySession: Record<string, CheckpointEntry[]>
  /**
   * The point each session's tree was last known to match, by session id.
   *
   * The newest capture, or the target of the last restore. Distinct from the
   * newest entry: after a restore the newest entry is the safety point, whose
   * state is exactly what the restore replaced — comparing the tree with it
   * would report the restore itself as someone else's edits.
   */
  head: Record<string, string>

  capture: (input: CaptureInput) => Promise<CheckpointEntry | null>
  /**
   * Record the tree as it stands, right before a restore.
   *
   * Unlike `capture`, a failure is returned with its reason: a restore must
   * not go ahead without it, and the person asking needs to know why.
   */
  captureSafety: (input: {
    sessionId: string
    root: string
    label: string
    access: string
  }) => Promise<CaptureResult>
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

const wire = (point: Checkpoint) => ({
  sha: point.sha,
  label: point.label,
  destination: point.destination,
  root: point.root,
})

export const useCoworkCheckpoints = create<CheckpointsState>()(
  persist(
    (set, get) => {
      const take = async (
        input: CaptureInput,
        extra: Partial<CheckpointEntry> = {}
      ): Promise<CaptureResult> => {
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
            ...extra,
          }
          set((s) => ({
            bySession: {
              ...s.bySession,
              [input.sessionId]: [...(s.bySession[input.sessionId] ?? []), entry],
            },
            head: { ...s.head, [input.sessionId]: entry.sha },
          }))
          return { ok: true, entry }
        } catch (e) {
          return { ok: false, reason: messageOf(e) }
        }
      }

      return {
        bySession: {},
        head: {},

        capture: async (input) => {
          const taken = await take(input)
          // A checkpoint that could not be taken is not a run that should
          // stop: the run is what the user asked for, and the absence of a way
          // back is reported by the list being empty rather than by a failure
          // here.
          return taken.ok ? taken.entry : null
        },

        captureSafety: (input) =>
          // Only ever before a restore, and restores only happen where Flint
          // owns the tree — which is also where the backend records the whole
          // working tree rather than a list of reported paths.
          take(
            { ...input, changed: [], destination: 'managed' },
            { safety: true }
          ),

        plan: async (sessionId, sha) => {
          const chain = get().bySession[sessionId] ?? []
          const target = chain.find((one) => one.sha === sha)
          if (!target) return { ok: false, reason: 'that point is not recorded' }
          // Compared with the state the tree was last known to be in, so
          // edits after it — and only those — are reported as newer.
          const known = get().head[sessionId]
          const latest =
            (known && chain.some((one) => one.sha === known) ? known : null) ??
            chain[chain.length - 1]?.sha ??
            sha
          try {
            return {
              ok: true,
              plan: await invoke<RewindPlan>('agent_checkpoint_plan', {
                checkpoint: wire(target),
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
          // The newest point, not the known head: the backend removes files
          // added between the target and this, and a safety point taken just
          // now is what holds every file currently on disk.
          const newest = chain[chain.length - 1]
          const latest = newest?.sha ?? sha
          // The safety point taken for this restore, named as such. The backend
          // refuses to restore unless the tree on disk is exactly what that
          // point holds, so an edit made between the capture and the restore —
          // or a restore attempted without any capture — is refused rather than
          // silently overwritten. Without it the backend applies the same check
          // against `latest`.
          const safety =
            newest && newest.safety && newest.sha !== sha ? newest.sha : null
          try {
            await invoke('agent_checkpoint_restore', {
              checkpoint: wire(target),
              latest,
              safety,
            })
          } catch (e) {
            return { ok: false, reason: messageOf(e) }
          }
          // Everything after the restored point describes a tree that no longer
          // exists, so it is dropped — except a safety point taken for this
          // restore, which is the way back from it.
          const at = chain.findIndex((one) => one.sha === sha)
          const kept = chain.slice(0, at + 1)
          if (newest && newest.safety && newest.sha !== sha) kept.push(newest)
          set((s) => ({
            bySession: { ...s.bySession, [sessionId]: kept },
            head: { ...s.head, [sessionId]: sha },
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
            const head = { ...s.head }
            delete head[sessionId]
            return { bySession: next, head }
          })
        },
      }
    },
    {
      name: localStorageKey.coworkCheckpoints,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      version: 1,
      // A chain persisted before `head` existed hydrates without it.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<CheckpointsState>
        return {
          ...current,
          ...saved,
          bySession: saved.bySession ?? current.bySession,
          head: saved.head ?? {},
        }
      },
    }
  )
)
