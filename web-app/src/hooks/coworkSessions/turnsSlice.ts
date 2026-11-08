import type { StateCreator } from 'zustand'
import { useUsageStats } from '@/stores/usage-stats-store'
import type { CoworkTurn } from '@/types/coworkSession'
import { stamped, withStoredTimes } from '@/lib/coworkSessionStamps'
import type { CoworkSessionsState } from './types'

const now = () => Date.now()

/** Counts a committed run's replies for the Overview dashboard. */
function recordCoworkUsage(turns: CoworkTurn[]) {
  const stats = useUsageStats.getState()
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue
    const tokens = turn.tokenSpeed?.tokenCount ?? turn.usage?.completion_tokens ?? 0
    const speed = turn.tokenSpeed?.tokenSpeed ?? 0
    stats.recordGeneration({
      tokens,
      durationMs: speed > 0 && tokens > 0 ? (tokens / speed) * 1000 : 0,
      at: turn.endedAt ?? Date.now(),
    })
  }
}

export type TurnsSlice = Pick<
  CoworkSessionsState,
  | 'commitTurns'
  | 'appendTurns'
  | 'rewindToLastUser'
>

export const createTurnsSlice: StateCreator<
  CoworkSessionsState,
  [['zustand/persist', unknown]],
  [],
  TurnsSlice
> = (set) => ({
  commitTurns: (id, turns, messages, subagents, usage) => {
    recordCoworkUsage(turns)
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== id) return x
        // Accumulate across this session's runs, keyed by runId — a later
        // run that dispatches no subagents of its own must not erase what
        // an earlier run in the same session already finished.
        const incoming = new Set(subagents.map((r) => r.runId))
        return {
          ...x,
          turns: [...x.turns, ...stamped(turns)],
          messages: withStoredTimes(x.messages ?? [], messages, now()),
          subagents: [
            ...(x.subagents ?? []).filter((r) => !incoming.has(r.runId)),
            ...subagents,
          ],
          lastUsage: usage ?? x.lastUsage,
          // Committed, so nothing of this run is in flight any more.
          inFlight: undefined,
          updated: now(),
        }
      }),
    }))
  },

  appendTurns: (id, turns) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id
          ? { ...x, turns: [...x.turns, ...stamped(turns)], updated: now() }
          : x
      ),
    })),

  rewindToLastUser: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) => {
        if (x.id !== id) return x
        const lastIndexOfUser = (roles: { role: string }[]) => {
          for (let i = roles.length - 1; i >= 0; i--) {
            if (roles[i].role === 'user') return i
          }
          return -1
        }
        const lastTurn = lastIndexOfUser(x.turns)
        const lastMessage = lastIndexOfUser(x.messages)
        if (lastTurn < 0 || lastMessage < 0) return x
        return {
          ...x,
          turns: x.turns.slice(0, lastTurn + 1),
          messages: x.messages.slice(0, lastMessage + 1),
          updated: now(),
        }
      }),
    })),
})
