/**
 * Overlapping team tasks, waiting on the person before any child starts.
 * AH-109.
 *
 * The team tool asks here and waits: nothing is provisioned and no child is
 * dispatched until every overlap has an answer. One request per session at a
 * time -- a run dispatches one team call at a time -- held in memory only,
 * because an unanswered request dies with the run that was waiting on it.
 */
import { create } from 'zustand'
import type {
  ConflictDecision,
  PairConflict,
  TeamTask,
} from '@/lib/coworkTeam'

/** One answer per conflict, by [`conflictKey`], or the whole team declined. */
export type ConflictAnswer =
  | { kind: 'decided'; decisions: Record<string, ConflictDecision> }
  | { kind: 'cancel' }

export type ConflictRequest = {
  sessionId: string
  callId: string
  tasks: TeamTask[]
  conflicts: PairConflict[]
  resolve: (answer: ConflictAnswer) => void
}

type State = {
  bySession: Record<string, ConflictRequest>
  request: (
    sessionId: string,
    callId: string,
    tasks: TeamTask[],
    conflicts: PairConflict[],
    signal?: AbortSignal
  ) => Promise<ConflictAnswer>
  answer: (sessionId: string, answer: ConflictAnswer) => void
}

export const useTeamConflictRequests = create<State>()((set, get) => ({
  bySession: {},

  request: (sessionId, callId, tasks, conflicts, signal) =>
    new Promise<ConflictAnswer>((resolve) => {
      const done = (answer: ConflictAnswer) => {
        signal?.removeEventListener('abort', onAbort)
        set((s) => {
          const next = { ...s.bySession }
          if (next[sessionId]?.callId === callId) delete next[sessionId]
          return { bySession: next }
        })
        resolve(answer)
      }
      // Stopping the run is declining the team: nothing waits forever on a
      // question the run that asked it no longer needs.
      const onAbort = () => done({ kind: 'cancel' })
      if (signal?.aborted) return done({ kind: 'cancel' })
      signal?.addEventListener('abort', onAbort, { once: true })
      // A request still open for this session is superseded, and answered as
      // declined rather than left hanging.
      get().bySession[sessionId]?.resolve({ kind: 'cancel' })
      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: { sessionId, callId, tasks, conflicts, resolve: done },
        },
      }))
    }),

  answer: (sessionId, answer) => get().bySession[sessionId]?.resolve(answer),
}))
