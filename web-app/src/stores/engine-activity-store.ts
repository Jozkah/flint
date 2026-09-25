import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * A short, local history of what the engine did: finished generations with
 * their speed, and MCP tool calls with their outcome. The engine pages draw
 * their charts and "today" figures from it, so every number shown is one
 * this machine measured rather than an estimate.
 *
 * Kept small on purpose: only the last day is retained and each list is
 * capped, so the persisted blob stays a few tens of KB at most.
 */
export type GenerationSample = {
  /** Epoch ms when the reply finished. */
  at: number
  model: string
  provider?: string
  /** Output tokens per second for the reply. */
  tps: number
}

export type ToolCallSample = {
  at: number
  server: string
  tool: string
  ok: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_GENERATIONS = 400
const MAX_TOOL_CALLS = 2000

type EngineActivityState = {
  generations: GenerationSample[]
  toolCalls: ToolCallSample[]
  recordGeneration: (sample: Omit<GenerationSample, 'at'> & { at?: number }) => void
  recordToolCall: (sample: Omit<ToolCallSample, 'at'> & { at?: number }) => void
}

const recent = <T extends { at: number }>(list: T[], cap: number, now: number) =>
  list.filter((s) => now - s.at < DAY_MS).slice(-cap)

export const useEngineActivity = create<EngineActivityState>()(
  persist(
    (set) => ({
      generations: [],
      toolCalls: [],
      recordGeneration: (sample) => {
        if (!(sample.tps > 0) || !Number.isFinite(sample.tps)) return
        const now = Date.now()
        set((s) => ({
          generations: recent(
            [...s.generations, { ...sample, at: sample.at ?? now }],
            MAX_GENERATIONS,
            now
          ),
        }))
      },
      recordToolCall: (sample) => {
        const now = Date.now()
        set((s) => ({
          toolCalls: recent(
            [...s.toolCalls, { ...sample, at: sample.at ?? now }],
            MAX_TOOL_CALLS,
            now
          ),
        }))
      },
    }),
    {
      name: 'flint-engine-activity',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ generations: s.generations, toolCalls: s.toolCalls }),
    }
  )
)

/** Record a finished generation. Safe to call from non-React code. */
export function recordGeneration(
  sample: Omit<GenerationSample, 'at'> & { at?: number }
) {
  try {
    useEngineActivity.getState().recordGeneration(sample)
  } catch {
    // Telemetry for a chart must never break a reply.
  }
}

/** Record a finished MCP tool call. Safe to call from non-React code. */
export function recordToolCall(
  sample: Omit<ToolCallSample, 'at'> & { at?: number }
) {
  try {
    useEngineActivity.getState().recordToolCall(sample)
  } catch {
    // As above: counting a call must never fail the call.
  }
}

/**
 * Counts per bucket over the last `buckets * bucketMs`, oldest first, for a
 * rate chart ("calls / min").
 */
export function bucketCounts<T extends { at: number }>(
  samples: T[],
  buckets: number,
  bucketMs: number,
  now = Date.now()
): number[] {
  const out = new Array<number>(buckets).fill(0)
  const start = now - buckets * bucketMs
  for (const s of samples) {
    if (s.at < start || s.at > now) continue
    const i = Math.min(buckets - 1, Math.floor((s.at - start) / bucketMs))
    out[i] += 1
  }
  return out
}

/** Start of the local day, for "today" figures. */
export function startOfToday(now = new Date()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
