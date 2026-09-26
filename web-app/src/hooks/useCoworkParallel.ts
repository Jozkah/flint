import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * Parallel sessions on one folder.
 *
 * Every new Cowork session attached to a Git folder works in its own managed
 * worktree and branch by default, so any number of sessions can edit the same
 * repository at once without writing over each other (or over the user's own
 * checkout). The setting turns that default off; a session can still pick an
 * access mode by hand either way.
 *
 * `auto` records which sessions were put in a worktree (or copy) by this
 * default, so reopening one after a restart re-attaches its own worktree
 * instead of dropping it to review-only, and so a session the user moved to
 * another mode is never moved back.
 */
export type AutoState = 'worktree' | 'copy' | 'skipped'

type ParallelState = {
  /** "New sessions in a Git folder work in their own worktree". */
  autoWorktree: boolean
  setAutoWorktree: (value: boolean) => void
  /** Keyed by `${sessionId}\u0000${folder}`. */
  auto: Record<string, AutoState>
  mark: (sessionId: string, folder: string, state: AutoState) => void
  markOf: (sessionId: string, folder: string) => AutoState | undefined
  /** Copy paths by session, so a copy session finds its copy after a restart. */
  copies: Record<string, string>
  setCopy: (sessionId: string, path: string | null) => void
  forgetSession: (sessionId: string) => void
}

const key = (sessionId: string, folder: string) => `${sessionId}\u0000${folder}`

export const useCoworkParallel = create<ParallelState>()(
  persist(
    (set, get) => ({
      autoWorktree: true,
      setAutoWorktree: (value) => set({ autoWorktree: value }),
      auto: {},
      mark: (sessionId, folder, state) =>
        set((s) => ({ auto: { ...s.auto, [key(sessionId, folder)]: state } })),
      markOf: (sessionId, folder) => get().auto[key(sessionId, folder)],
      copies: {},
      setCopy: (sessionId, path) =>
        set((s) => {
          const copies = { ...s.copies }
          if (path) copies[sessionId] = path
          else delete copies[sessionId]
          return { copies }
        }),
      forgetSession: (sessionId) =>
        set((s) => {
          const auto = Object.fromEntries(
            Object.entries(s.auto).filter(
              ([k]) => !k.startsWith(`${sessionId}\u0000`)
            )
          )
          const copies = { ...s.copies }
          delete copies[sessionId]
          return { auto, copies }
        }),
    }),
    {
      name: 'flint-cowork-parallel',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
