import { create } from 'zustand'
import type { CompletionSummary, OriginEntry } from '@/lib/coworkOrigins'

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
  entries: OriginEntry[]
  summary: CompletionSummary
  /** When the run this describes finished. */
  at: number
}

type OriginsState = {
  bySession: Record<string, SessionOrigins>
  record: (sessionId: string, origins: SessionOrigins) => void
  forSession: (sessionId: string | null | undefined) => SessionOrigins | null
  forget: (sessionId: string) => void
}

export const useCoworkOrigins = create<OriginsState>()((set, get) => ({
  bySession: {},
  record: (sessionId, origins) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: origins } })),
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
