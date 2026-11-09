// The Cowork run store's run lifecycle.

import type { StoreApi } from 'zustand'
import type { CoworkTurn } from '@/types/coworkSession'
import type { CoworkRunState, SetRun } from './types'
import { interruptRunningTools, omitKey } from './turns'

/** Starting, finishing, finalizing and forgetting a run. */
export const runLifecycleSlice = (
  set: SetRun,
  get: StoreApi<CoworkRunState>['getState']
): Pick<
  CoworkRunState,
  | 'startRun'
  | 'setRunTurns'
  | 'finishRun'
  | 'forgetSession'
  | 'finalizeRun'
  | 'clearCodeRun'
> => ({
  startRun: (sid, runId) =>
    set((s) => ({
      runs: { ...s.runs, [sid]: { runId, startedAt: Date.now() } },
      outcomes: omitKey(s.outcomes, sid),
      usage: omitKey(s.usage, sid),
      liveTurns: { ...s.liveTurns, [sid]: [] },
      subagents: { ...s.subagents, [sid]: [] },
    })),

  setRunTurns: (sid, runId, turns) =>
    set((s) =>
      s.runs[sid]?.runId === runId
        ? { liveTurns: { ...s.liveTurns, [sid]: turns } }
        : {}
    ),

  finishRun: (sid, runId, ending) =>
    set((s) => {
      if (s.runs[sid]?.runId !== runId) return {}
      return {
        runs: omitKey(s.runs, sid),
        outcomes: ending
          ? { ...s.outcomes, [sid]: ending }
          : omitKey(s.outcomes, sid),
        liveTurns: omitKey(s.liveTurns, sid),
      }
    }),

  forgetSession: (sid) =>
    set((s) => ({
      runs: omitKey(s.runs, sid),
      outcomes: omitKey(s.outcomes, sid),
      liveTurns: omitKey(s.liveTurns, sid),
      usage: omitKey(s.usage, sid),
      subagents: omitKey(s.subagents, sid),
      pendingAsks: omitKey(s.pendingAsks, sid),
      promptSnapshots: omitKey(s.promptSnapshots, sid),
      llamacppRuns: omitKey(s.llamacppRuns, sid),
      pendingLlamacppError: omitKey(s.pendingLlamacppError, sid),
      loadingModels: omitKey(s.loadingModels, sid),
      modelLoadProgress: omitKey(s.modelLoadProgress, sid),
    })),
  finalizeRun: (sid) => {
    // Run-level failure surfaces via `useMessageErrors` (Generation-failed
    // banner), not as a synthetic tool-error turn — that used to render a
    // misleading error-styled tool card even though no tool call failed.
    const turns: CoworkTurn[] = interruptRunningTools(get().liveTurns[sid] ?? [])
    const subs = (get().subagents[sid] ?? []).map((r) => {
      const subTurns = interruptRunningTools(r.turns ?? [])
      // A record already done with nothing left running keeps its identity.
      if (r.status === 'done' && subTurns === r.turns) return r
      return {
        ...r,
        turns: subTurns,
        status: 'done' as const,
        endedAt: r.endedAt ?? Date.now(),
      }
    })
    set((s) => ({
      liveTurns: { ...s.liveTurns, [sid]: turns },
      subagents: { ...s.subagents, [sid]: subs },
    }))
    return { turns, subagents: subs }
  },

  clearCodeRun: (sid) =>
    set((s) => ({
      liveTurns: omitKey(s.liveTurns, sid),
      subagents: omitKey(s.subagents, sid),
      pendingAsks: omitKey(s.pendingAsks, sid),
      usage: omitKey(s.usage, sid),
      llamacppRuns: omitKey(s.llamacppRuns, sid),
      pendingLlamacppError: omitKey(s.pendingLlamacppError, sid),
      loadingModels: omitKey(s.loadingModels, sid),
      modelLoadProgress: omitKey(s.modelLoadProgress, sid),
    })),
})
