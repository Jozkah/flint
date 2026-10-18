import { describe, it, expect, vi } from 'vitest'
import type { Tool } from 'ai'
import {
  ROOM_TOOL_BUDGET_CEILINGS,
  applyToolBudget,
  dropDisabledTools,
  resolveToolBudget,
} from '../toolBudget'

const tool = (fn: (i: unknown, o?: { abortSignal?: AbortSignal }) => unknown): Tool =>
  ({ description: 'x', execute: fn }) as unknown as Tool
const exec = (t: Tool, input: unknown = {}, options: unknown = {}) =>
  (t as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, options)

describe('resolveToolBudget', () => {
  it('uses access defaults when unset', () => {
    expect(resolveToolBudget(undefined, 'read').maxSteps).toBe(8)
    expect(resolveToolBudget(undefined, 'full').maxSteps).toBe(30)
    expect(resolveToolBudget(undefined, 'edit').maxToolCalls).toBeGreaterThan(0)
  })
  it('honours set values and clamps absurd ones', () => {
    const b = resolveToolBudget({ maxToolCalls: 3, maxSteps: 4, toolTimeoutSec: 5 }, 'full')
    expect(b).toEqual({ maxToolCalls: 3, maxSteps: 4, toolTimeoutSec: 5 })
    const c = resolveToolBudget({ maxToolCalls: 1e9, maxSteps: -2, toolTimeoutSec: Number.NaN }, 'read')
    expect(c.maxToolCalls).toBe(ROOM_TOOL_BUDGET_CEILINGS.maxToolCalls)
    expect(c.maxSteps).toBe(1)
    expect(c.toolTimeoutSec).toBe(resolveToolBudget(undefined, 'read').toolTimeoutSec)
  })
})

describe('applyToolBudget', () => {
  it('refuses calls past the cap and reports the hit once', async () => {
    const onHit = vi.fn()
    const run = vi.fn(async () => 'ok')
    const tools = applyToolBudget({ a: tool(run) }, { maxToolCalls: 2, maxSteps: 5, toolTimeoutSec: 10 }, onHit)
    expect(await exec(tools.a)).toBe('ok')
    expect(await exec(tools.a)).toBe('ok')
    expect(String(await exec(tools.a))).toMatch(/ERROR: .*tool calls/)
    expect(String(await exec(tools.a))).toMatch(/ERROR/)
    expect(run).toHaveBeenCalledTimes(2)
    expect(onHit).toHaveBeenCalledWith('tool-calls')
  })

  it('gives up on a call past the timeout and aborts it', async () => {
    vi.useFakeTimers()
    const onHit = vi.fn()
    let aborted = false
    const slow = tool(
      (_i, o) =>
        new Promise((resolve) => {
          o?.abortSignal?.addEventListener('abort', () => {
            aborted = true
            resolve('late')
          })
        })
    )
    const tools = applyToolBudget({ s: slow }, { maxToolCalls: 5, maxSteps: 5, toolTimeoutSec: 2 }, onHit)
    const p = exec(tools.s)
    await vi.advanceTimersByTimeAsync(2_100)
    expect(String(await p)).toMatch(/ERROR: .*timed out after 2s/)
    expect(aborted).toBe(true)
    expect(onHit).toHaveBeenCalledWith('timeout')
    vi.useRealTimers()
  })
})

describe('dropDisabledTools', () => {
  it('only removes, never adds', () => {
    const tools = { read: tool(() => 1), bash: tool(() => 2) }
    expect(Object.keys(dropDisabledTools(tools, ['bash', 'not-there']))).toEqual(['read'])
    expect(Object.keys(dropDisabledTools(tools, undefined))).toEqual(['read', 'bash'])
  })
})
