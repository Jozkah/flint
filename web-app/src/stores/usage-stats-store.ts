import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { computeCost, type ModelPricing } from '@/lib/tokenUsage'

/**
 * Local usage figures for the Overview dashboard: what the models generated,
 * how fast, and how tool calls went, bucketed by local calendar day, plus a
 * short feed of notable events. Everything is counted on this computer as it
 * happens and never leaves it; the store starts empty and keeps 90 days.
 */

export type DayStats = {
  /** Output tokens generated. */
  tokens: number
  /** Generation time for the requests that reported a speed, in ms. */
  genMs: number
  /** Output tokens of the requests that reported a speed (speed denominator). */
  timedTokens: number
  /** Replies finished. */
  replies: number
  toolOk: number
  toolFail: number
  /** Dollars spent, priced when each reply finished. Absent on older days. */
  cost?: number
}

export type ActivityKind =
  | 'tool-approved'
  | 'tool-denied'
  | 'tool-failed'
  | 'model-loaded'
  | 'model-swapped'
  | 'compaction'
  | 'run-finished'
  | 'knowledge'
  | 'warning'

export type ActivityItem = {
  id: string
  kind: ActivityKind
  title: string
  detail?: string
  at: number
}

type UsageStatsState = {
  days: Record<string, DayStats>
  activity: ActivityItem[]
  /** Optional $ per 1M tokens by model id; a model without an entry costs 0. */
  pricing: Record<string, ModelPricing>
  setPricing: (model: string, pricing: ModelPricing | null) => void
  recordGeneration: (g: {
    tokens: number
    durationMs: number
    at?: number
    model?: string
    inputTokens?: number
  }) => void
  recordToolCall: (ok: boolean, at?: number) => void
  pushActivity: (item: Omit<ActivityItem, 'id' | 'at'> & { at?: number }) => void
  reset: () => void
}

const KEEP_DAYS = 90
const KEEP_ACTIVITY = 120

export const emptyDay = (): DayStats => ({
  tokens: 0,
  genMs: 0,
  timedTokens: 0,
  replies: 0,
  toolOk: 0,
  toolFail: 0,
})

/** Local calendar day, so "today" matches the user's clock, not UTC. */
export function dayKey(at: number): string {
  const d = new Date(at)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function prune(days: Record<string, DayStats>, now: number) {
  const cutoff = dayKey(now - KEEP_DAYS * 86_400_000)
  const out: Record<string, DayStats> = {}
  for (const [k, v] of Object.entries(days)) if (k >= cutoff) out[k] = v
  return out
}

function bump(
  days: Record<string, DayStats>,
  at: number,
  change: (d: DayStats) => DayStats
) {
  const key = dayKey(at)
  return prune({ ...days, [key]: change(days[key] ?? emptyDay()) }, at)
}

export const useUsageStats = create<UsageStatsState>()(
  persist(
    (set) => ({
      days: {},
      activity: [],
      pricing: {},
      setPricing: (model, pricing) =>
        set((s) => {
          const rest = { ...s.pricing }
          delete rest[model]
          return { pricing: pricing ? { ...rest, [model]: pricing } : rest }
        }),
      recordGeneration: ({ tokens, durationMs, at = Date.now(), model, inputTokens }) => {
        if (!(tokens > 0)) return
        set((s) => ({
          days: bump(s.days, at, (d) => ({
            ...d,
            tokens: d.tokens + tokens,
            cost:
              (d.cost ?? 0) +
              computeCost(model ? s.pricing[model] : undefined, inputTokens, tokens),
            replies: d.replies + 1,
            ...(durationMs > 0
              ? { genMs: d.genMs + durationMs, timedTokens: d.timedTokens + tokens }
              : {}),
          })),
        }))
      },
      recordToolCall: (ok, at = Date.now()) =>
        set((s) => ({
          days: bump(s.days, at, (d) =>
            ok ? { ...d, toolOk: d.toolOk + 1 } : { ...d, toolFail: d.toolFail + 1 }
          ),
        })),
      pushActivity: ({ at = Date.now(), ...item }) =>
        set((s) => ({
          activity: [
            { ...item, at, id: `${at}-${Math.random().toString(36).slice(2, 8)}` },
            ...s.activity,
          ].slice(0, KEEP_ACTIVITY),
        })),
      reset: () => set({ days: {}, activity: [] }),
    }),
    {
      name: 'flint-usage-stats',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ days: s.days, activity: s.activity, pricing: s.pricing }),
    }
  )
)

export type RangeSummary = {
  tokens: number
  /** Dollars spent over the range. */
  cost: number
  /** Output tokens per second over the timed requests, or null with none. */
  speed: number | null
  /** Tool calls that succeeded, 0..1, or null with none. */
  toolSuccess: number | null
  toolCalls: number
  replies: number
  /** One entry per day, oldest first. */
  series: { key: string; date: Date; stats: DayStats }[]
}

/** Figures for the `days` days ending on the day of `end`. */
export function summarize(
  days: Record<string, DayStats>,
  count: number,
  end: number
): RangeSummary {
  const series: RangeSummary['series'] = []
  const endDate = new Date(end)
  endDate.setHours(12, 0, 0, 0)
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(endDate)
    date.setDate(endDate.getDate() - i)
    const key = dayKey(date.getTime())
    series.push({ key, date, stats: days[key] ?? emptyDay() })
  }
  const total = series.reduce((acc, { stats }) => {
    acc.tokens += stats.tokens
    acc.genMs += stats.genMs
    acc.timedTokens += stats.timedTokens
    acc.replies += stats.replies
    acc.toolOk += stats.toolOk
    acc.toolFail += stats.toolFail
    acc.cost = (acc.cost ?? 0) + (stats.cost ?? 0)
    return acc
  }, emptyDay())
  const toolCalls = total.toolOk + total.toolFail
  return {
    tokens: total.tokens,
    cost: total.cost ?? 0,
    speed: total.genMs > 0 ? total.timedTokens / (total.genMs / 1000) : null,
    toolSuccess: toolCalls > 0 ? total.toolOk / toolCalls : null,
    toolCalls,
    replies: total.replies,
    series,
  }
}

/** Relative change, or null when there is nothing to compare against. */
export function change(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null
  return (current - previous) / previous
}
