// The Cowork run store's stream writes.

import type { CoworkRunState, SetRun } from './types'
import { appendAssistantToken, mergeToolResult } from './turns'

/** What the stream writes into the live turns, and the usage it reports. */
export const runStreamSlice = (
  set: SetRun
): Pick<
  CoworkRunState,
  | 'appendToken'
  | 'pushToolTurn'
  | 'updateToolTurn'
  | 'announceToolCall'
  | 'appendToolArgs'
  | 'setUsage'
> => ({
  appendToken: (sid, text) =>
    set((s) => ({
      liveTurns: {
        ...s.liveTurns,
        [sid]: appendAssistantToken(s.liveTurns[sid] ?? [], text),
      },
    })),

  pushToolTurn: (sid, turn) =>
    set((s) => ({
      liveTurns: { ...s.liveTurns, [sid]: [...(s.liveTurns[sid] ?? []), turn] },
    })),

  updateToolTurn: (sid, callId, patch) =>
    set((s) => {
      const turns = s.liveTurns[sid] ?? []
      const next = mergeToolResult(turns, callId, patch)
      return next === turns ? {} : { liveTurns: { ...s.liveTurns, [sid]: next } }
    }),

  announceToolCall: (sid, id, name) =>
    set((s) => {
      const turns = s.liveTurns[sid] ?? []
      if (turns.some((tn) => tn.role === 'tool' && tn.callId === id)) return {}
      return {
        liveTurns: {
          ...s.liveTurns,
          [sid]: [
            ...turns,
            { role: 'tool', content: '', callId: id, name, args: null, argsLive: '', status: 'running' },
          ],
        },
      }
    }),

  appendToolArgs: (sid, id, delta) =>
    set((s) => {
      const turns = s.liveTurns[sid] ?? []
      const idx = turns.findIndex((tn) => tn.role === 'tool' && tn.callId === id)
      if (idx === -1) return {}
      const prev = turns[idx].argsLive ?? ''
      return {
        liveTurns: {
          ...s.liveTurns,
          [sid]: [...turns.slice(0, idx), { ...turns[idx], argsLive: prev + delta }, ...turns.slice(idx + 1)],
        },
      }
    }),

  setUsage: (sid, usage) =>
    set((s) => (usage ? { usage: { ...s.usage, [sid]: usage } } : {})),
})
