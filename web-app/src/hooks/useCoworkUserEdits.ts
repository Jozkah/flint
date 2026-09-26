import { create } from 'zustand'
import type { Buffers } from '@/lib/coworkCodeEdit'

/**
 * Files the user edited by hand in the Code panel, per session.
 *
 * Two readers. The Changes panel lists each saved edit beside the agent's,
 * attributed to the user. The next message the user sends takes the unsent
 * ones (`takePending`), so the agent is told which files changed under it and
 * re-reads them rather than editing from a stale picture.
 *
 * In memory only: the backend's undo journal is the durable record of the
 * write itself, with the user as its actor.
 */
export type UserEdit = {
  /** As the tab names it: project-relative, or relative to the sandbox. */
  path: string
  /** The path the write tool was given, which is what diffs are keyed by. */
  writtenPath: string
  where: 'real' | 'sandbox'
  /** The backend's diff of the write, in the tool's own format. */
  diff?: string
  at: number
}

type SessionEdits = {
  edits: UserEdit[]
  /** Edits the agent has not yet been told about. */
  pending: UserEdit[]
}

type UserEditsState = {
  bySession: Record<string, SessionEdits>
  record: (sessionId: string, edit: UserEdit) => void
  /** Hand over the edits the agent has not heard about, and forget them. */
  takePending: (sessionId: string | null | undefined) => UserEdit[]
  forget: (sessionId: string) => void
}

const EMPTY: SessionEdits = { edits: [], pending: [] }

export const useCoworkUserEdits = create<UserEditsState>()((set, get) => ({
  bySession: {},
  record: (sessionId, edit) =>
    set((s) => {
      const current = s.bySession[sessionId] ?? EMPTY
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: {
            edits: [...current.edits, edit],
            pending: [...current.pending, edit],
          },
        },
      }
    }),
  takePending: (sessionId) => {
    if (!sessionId) return []
    const current = get().bySession[sessionId]
    if (!current || current.pending.length === 0) return []
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { ...current, pending: [] },
      },
    }))
    return current.pending
  },
  forget: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    }),
}))

/** Stable empty list for selectors, so an idle session does not re-render. */
export const NO_USER_EDITS: UserEdit[] = []

/**
 * The Code panel's open editor buffers, per session.
 *
 * Outside the panel so switching the rail to Changes and back, or to another
 * session and back, keeps unsaved text. In memory only: unsaved edits do not
 * survive a restart, the same as an editor without hot exit.
 */
type BuffersState = {
  bySession: Record<string, Buffers>
  update: (sessionId: string, next: (current: Buffers) => Buffers) => void
}

export const NO_BUFFERS: Buffers = {}

export const useCodeBuffers = create<BuffersState>()((set) => ({
  bySession: {},
  update: (sessionId, next) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: next(s.bySession[sessionId] ?? NO_BUFFERS),
      },
    })),
}))
