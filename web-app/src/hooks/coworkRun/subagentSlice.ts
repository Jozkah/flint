// The Cowork run store's subagent rows.

import type { CoworkRunState, SetRun } from './types'
import { applyInnerToTurns } from './turns'

/** The subagent rows of a session's run. */
export const subagentActions = (
  set: SetRun
): Pick<
  CoworkRunState,
  'resetSubagents'
  | 'startSubagent'
  | 'queueSubagent'
  | 'endSubagent'
  | 'routeIntoSubagent'
  | 'attachSubagentOutput'
> => ({
  resetSubagents: (sid) =>
    set((s) => ({ subagents: { ...s.subagents, [sid]: [] } })),

  startSubagent: (sid, runId, name) =>
    set((s) => {
      const runs = s.subagents[sid] ?? []
      // Promote a queued child the moment its slot frees; otherwise create it.
      const idx = runs.findIndex((r) => r.runId === runId)
      if (idx !== -1) {
        const existing = runs[idx]
        if (existing.status === 'queued') {
          return {
            subagents: {
              ...s.subagents,
              [sid]: [
                ...runs.slice(0, idx),
                { ...existing, status: 'running' as const, waiting: undefined, startedAt: Date.now() },
                ...runs.slice(idx + 1),
              ],
            },
          }
        }
        return {}
      }
      return {
        subagents: {
          ...s.subagents,
          [sid]: [
            ...runs,
            { runId, name, status: 'running', startedAt: Date.now(), turns: [] },
          ],
        },
      }
    }),

  queueSubagent: (sid, runId, name, waiting) =>
    set((s) => {
      const runs = s.subagents[sid] ?? []
      if (runs.some((r) => r.runId === runId)) return {}
      return {
        subagents: {
          ...s.subagents,
          [sid]: [
            ...runs,
            { runId, name, status: 'queued', waiting, startedAt: Date.now(), turns: [] },
          ],
        },
      }
    }),


  endSubagent: (sid, runId, usage) =>
    set((s) => ({
      subagents: {
        ...s.subagents,
        [sid]: (s.subagents[sid] ?? []).map((r) =>
          r.runId === runId && r.status !== 'done'
            ? {
                ...r,
                status: 'done' as const,
                endedAt: Date.now(),
                usage: usage ?? undefined,
              }
            : r
        ),
      },
    })),

  routeIntoSubagent: (sid, runId, inner) =>
    set((s) => ({
      subagents: {
        ...s.subagents,
        [sid]: (s.subagents[sid] ?? []).map((r) =>
          r.runId === runId ? { ...r, turns: applyInnerToTurns(r.turns, inner) } : r
        ),
      },
    })),

  attachSubagentOutput: (sid, runId, content) =>
    set((s) => ({
      subagents: {
        ...s.subagents,
        [sid]: (s.subagents[sid] ?? []).map((r) =>
          r.runId === runId && r.finalOutput == null ? { ...r, finalOutput: content } : r
        ),
      },
    })),
})
