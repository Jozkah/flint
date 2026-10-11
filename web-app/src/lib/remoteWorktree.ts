/**
 * What the server said about a remote session's worktree and proposals, kept
 * for the panel that shows them. `remoteCowork.ts` feeds it from the live
 * stream; the panel re-reads the authoritative state over the wire whenever a
 * tick arrives, so a missed event costs a stale second, not a wrong answer.
 */
import { create } from 'zustand'

export type ProposalNote = {
  proposalId: string
  files: number
  additions: number
  deletions: number
}

type State = {
  /** Bumped when something about the worktree may have changed. */
  ticks: Record<string, number>
  proposals: Record<string, ProposalNote | undefined>
  errors: Record<string, string | undefined>
  bump: (sid: string) => void
  proposalCreated: (sid: string, payload: Record<string, unknown>) => void
  proposalFailed: (sid: string, message: string) => void
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const useRemoteWorktrees = create<State>()((set) => ({
  ticks: {},
  proposals: {},
  errors: {},
  bump: (sid) => set((s) => ({ ticks: { ...s.ticks, [sid]: (s.ticks[sid] ?? 0) + 1 } })),
  proposalCreated: (sid, payload) =>
    set((s) => ({
      ticks: { ...s.ticks, [sid]: (s.ticks[sid] ?? 0) + 1 },
      proposals: {
        ...s.proposals,
        [sid]: {
          proposalId: String(payload.proposalId ?? ''),
          files: num(payload.files),
          additions: num(payload.additions),
          deletions: num(payload.deletions),
        },
      },
      errors: { ...s.errors, [sid]: undefined },
    })),
  proposalFailed: (sid, message) =>
    set((s) => ({
      ticks: { ...s.ticks, [sid]: (s.ticks[sid] ?? 0) + 1 },
      errors: { ...s.errors, [sid]: message },
    })),
}))
