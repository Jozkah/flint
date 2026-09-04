import { create } from 'zustand'
import type {
  CompletionSummary,
  OriginEntry,
  RunOrigins,
} from '@/lib/coworkOrigins'

/**
 * The last run's origin ledger, per session.
 *
 * One record, read by every surface that talks about what changed, so the
 * completion summary, the Changes panel and the activity list cannot describe
 * the same file three different ways.
 *
 * Not persisted, and deliberately so. The ledger is only true of the run that
 * produced it: after a restart the evidence behind it — the baseline, the
 * transcript's tool rows, the authority the run held — is gone, and a
 * surviving summary would be a claim with nothing left to support it.
 *
 * Withdrawing access changes what Jan may do next. It does not change what
 * happened, so nothing here is rewritten when a grant is handed back.
 */
export type SessionOrigins = {
  /**
   * Where this run's changes go, frozen when it started.
   *
   * Written before the first tool call rather than after the run, because the
   * surfaces that need it most — the prompt and readiness — are asked during
   * the run, not once it is over.
   */
  context: RunOrigins
  /** Empty until the run ends: nothing is known about a run still going. */
  entries: OriginEntry[]
  summary: CompletionSummary | null
  /** When the run this describes finished, or null while it is running. */
  at: number | null
}

const EMPTY_LEDGER = { entries: [], summary: null, at: null }

type OriginsState = {
  bySession: Record<string, SessionOrigins>
  /** Start a run: publish its frozen context, and clear the last run's ledger. */
  begin: (sessionId: string, context: RunOrigins) => void
  /** Finish a run: attach what the evidence showed. */
  record: (
    sessionId: string,
    ledger: { entries: OriginEntry[]; summary: CompletionSummary; at: number }
  ) => void
  forSession: (sessionId: string | null | undefined) => SessionOrigins | null
  forget: (sessionId: string) => void
}

export const useCoworkOrigins = create<OriginsState>()((set, get) => ({
  bySession: {},
  begin: (sessionId, context) =>
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: { context, ...EMPTY_LEDGER } },
    })),
  record: (sessionId, ledger) =>
    set((s) => {
      const existing = s.bySession[sessionId]
      // A ledger with no context is a ledger for a run nobody started. It is
      // dropped rather than stored under a context invented here.
      if (!existing) return s
      return {
        bySession: { ...s.bySession, [sessionId]: { ...existing, ...ledger } },
      }
    }),
  forSession: (sessionId) =>
    sessionId ? (get().bySession[sessionId] ?? null) : null,
  forget: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s
      const bySession = { ...s.bySession }
      delete bySession[sessionId]
      return { bySession }
    }),
}))
