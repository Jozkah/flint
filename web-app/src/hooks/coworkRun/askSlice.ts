// The Cowork run store's pending questions and prompt snapshots.

import type { CoworkRunState, SetRun } from './types'
import { attachAskToTurns, settleAskInTurns, attachPromptSnapshotToTurns } from './turns'

/** Questions the agent asked the user, and the prompt snapshots beside them. */
export const askActions = (
  set: SetRun
): Pick<
  CoworkRunState,
  'addPendingAsk'
  | 'removePendingAsk'
  | 'attachAsk'
  | 'recordPromptSnapshot'
  | 'attachPromptSnapshot'
  | 'settleAsk'
> => ({
  addPendingAsk: (sid, requestId, request) =>
    set((s) => ({
      pendingAsks: {
        ...s.pendingAsks,
        [sid]: [...(s.pendingAsks[sid] ?? []), { requestId, request }],
      },
    })),

  removePendingAsk: (sid, requestId) =>
    set((s) => ({
      pendingAsks: {
        ...s.pendingAsks,
        [sid]: (s.pendingAsks[sid] ?? []).filter((a) => a.requestId !== requestId),
      },
    })),

  attachAsk: (sid, record) =>
    set((st) => ({
      liveTurns: {
        ...st.liveTurns,
        [sid]: attachAskToTurns(st.liveTurns[sid] ?? [], record),
      },
    })),

  recordPromptSnapshot: (sid, ref) =>
    set((st) => {
      const seen = st.promptSnapshots[sid] ?? []
      if (seen.some((s) => s.id === ref.id)) return {}
      return {
        promptSnapshots: { ...st.promptSnapshots, [sid]: [...seen, ref] },
      }
    }),

  attachPromptSnapshot: (sid, ref) =>
    set((st) => ({
      liveTurns: {
        ...st.liveTurns,
        [sid]: attachPromptSnapshotToTurns(st.liveTurns[sid] ?? [], ref),
      },
    })),

  settleAsk: (sid, requestId, state, answers) =>
    set((st) => ({
      liveTurns: {
        ...st.liveTurns,
        [sid]: settleAskInTurns(
          st.liveTurns[sid] ?? [],
          requestId,
          state,
          // Pasted pictures go to the model, not into the saved transcript.
          answers?.map((a) => ({
            id: a.id,
            selected: a.selected,
            ...(a.custom_input !== undefined
              ? { custom_input: a.custom_input }
              : {}),
          }))
        ),
      },
    })),
})
