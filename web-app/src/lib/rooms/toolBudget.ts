/**
 * Per-turn tool budgets and the per-participant tool picker, applied to the
 * tools a room participant is given. Both only narrow: a budget refuses calls
 * past it, the picker drops tools. Neither adds a tool or skips an approval.
 */
import type { Tool } from 'ai'
import type { RoomBudgetHit, RoomToolBudget, ToolAccess } from './types'

export type ResolvedToolBudget = Required<RoomToolBudget>

/** Steps per turn by access, as before budgets were editable. */
const DEFAULT_STEPS: Record<ToolAccess, number> = { none: 8, read: 8, edit: 8, full: 30 }
export const ROOM_TOOL_BUDGET_DEFAULTS = { maxToolCalls: 40, toolTimeoutSec: 300 } as const
export const ROOM_TOOL_BUDGET_CEILINGS = { maxToolCalls: 200, maxSteps: 60, toolTimeoutSec: 1800 } as const

function clampTo(value: unknown, fallback: number, ceiling: number): number {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(ceiling, Math.floor(n)))
}

/** The budget a turn runs with: the room's, else the defaults for the access. */
export function resolveToolBudget(
  budget: RoomToolBudget | undefined,
  access: ToolAccess
): ResolvedToolBudget {
  const c = ROOM_TOOL_BUDGET_CEILINGS
  return {
    maxToolCalls: clampTo(budget?.maxToolCalls, ROOM_TOOL_BUDGET_DEFAULTS.maxToolCalls, c.maxToolCalls),
    maxSteps: clampTo(budget?.maxSteps, DEFAULT_STEPS[access], c.maxSteps),
    toolTimeoutSec: clampTo(budget?.toolTimeoutSec, ROOM_TOOL_BUDGET_DEFAULTS.toolTimeoutSec, c.toolTimeoutSec),
  }
}

type Exec = (input: unknown, options?: { abortSignal?: AbortSignal; [k: string]: unknown }) => unknown

/**
 * Wrap each tool so the turn stops calling past `maxToolCalls` and a call that
 * runs past `toolTimeoutSec` is aborted and answered with an error. `onHit` is
 * told which budget was reached (once per kind).
 */
export function applyToolBudget(
  tools: Record<string, Tool>,
  budget: ResolvedToolBudget,
  onHit: (hit: RoomBudgetHit) => void
): Record<string, Tool> {
  let calls = 0
  const seen = new Set<RoomBudgetHit>()
  const hit = (h: RoomBudgetHit) => {
    if (seen.has(h)) return
    seen.add(h)
    onHit(h)
  }
  const out: Record<string, Tool> = {}
  for (const [name, tool] of Object.entries(tools)) {
    const exec = (tool as { execute?: Exec }).execute
    if (!exec) {
      out[name] = tool
      continue
    }
    out[name] = {
      ...tool,
      execute: async (input: unknown, options?: { abortSignal?: AbortSignal }) => {
        if (calls >= budget.maxToolCalls) {
          hit('tool-calls')
          return `ERROR: this turn has used its ${budget.maxToolCalls} tool calls. Do not call more tools: write your reply now.`
        }
        calls++
        const ctrl = new AbortController()
        const parent = options?.abortSignal
        const onParent = () => ctrl.abort()
        if (parent?.aborted) ctrl.abort()
        else parent?.addEventListener('abort', onParent, { once: true })
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<string>((resolve) => {
          timer = setTimeout(() => {
            hit('timeout')
            // Answer first, then stop the call: its own late result loses.
            setTimeout(() => ctrl.abort(), 0)
            resolve(`ERROR: ${name} timed out after ${budget.toolTimeoutSec}s and was stopped.`)
          }, budget.toolTimeoutSec * 1000)
        })
        try {
          return await Promise.race([
            Promise.resolve(exec(input, { ...(options ?? {}), abortSignal: ctrl.signal })),
            timeout,
          ])
        } finally {
          if (timer) clearTimeout(timer)
          parent?.removeEventListener('abort', onParent)
        }
      },
    } as Tool
  }
  return out
}

/** Drop the tools the user switched off for this participant. */
export function dropDisabledTools<T>(
  tools: Record<string, T>,
  disabled: readonly string[] | undefined
): Record<string, T> {
  if (!disabled?.length) return tools
  const off = new Set(disabled)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !off.has(name)))
}
