import { describe, it, expect } from 'vitest'
import { __testing, canSpawn, subagentTools } from '../coworkSubagent'
import {
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  clampMaxConcurrent,
  clampMaxDepth,
} from '../subagentSettings'
import { TASK_TOOL_NAME, TEAM_TOOL_NAME } from '../coworkTools'

const tool = {} as never
const parent = { read: tool, [TASK_TOOL_NAME]: tool, [TEAM_TOOL_NAME]: tool }

describe('limits settings', () => {
  it('defaults to 8 concurrent and depth 1, and clamps nonsense', () => {
    expect(DEFAULT_MAX_CONCURRENT_SUBAGENTS).toBe(8)
    expect(clampMaxConcurrent(undefined)).toBe(8)
    expect(clampMaxConcurrent('abc')).toBe(8)
    expect(clampMaxConcurrent('')).toBe(8)
    expect(clampMaxConcurrent(0)).toBe(1)
    expect(clampMaxConcurrent(99)).toBe(16)
    expect(clampMaxConcurrent('5.9')).toBe(5)
    expect(clampMaxDepth(undefined)).toBe(1)
    expect(clampMaxDepth(0)).toBe(1)
    expect(clampMaxDepth(2)).toBe(2)
    expect(clampMaxDepth(9)).toBe(3)
  })
})

describe('spawn depth', () => {
  it('today: children never get task or team', () => {
    expect(Object.keys(subagentTools(parent, null))).toEqual(['read'])
    expect(Object.keys(subagentTools(parent, null, { depth: 1, maxDepth: 1 }))).toEqual(['read'])
  })
  it('below the limit a child gets task only; at the limit it is withheld again', () => {
    expect(Object.keys(subagentTools(parent, null, { depth: 1, maxDepth: 2 }))).toEqual(['read', TASK_TOOL_NAME])
    expect(Object.keys(subagentTools(parent, null, { depth: 2, maxDepth: 2 }))).toEqual(['read'])
    expect(canSpawn({ depth: 2, maxDepth: 3 })).toBe(true)
    expect(canSpawn(undefined)).toBe(false)
  })
  it('an allowlist still narrows a spawning child', () => {
    expect(Object.keys(subagentTools(parent, ['read'], { depth: 1, maxDepth: 3 }))).toEqual(['read'])
  })
})

describe('semaphore cap', () => {
  it('queues past the cap and starts waiters when it is raised', async () => {
    const gate = new __testing.Semaphore(1)
    const first = await gate.acquire()
    let second = false
    const p = gate.acquire().then((r) => {
      second = true
      return r
    })
    await Promise.resolve()
    expect(second).toBe(false)
    expect(gate.waiting).toBe(1)
    gate.setCap(2)
    const r2 = await p
    expect(second).toBe(true)
    first()
    r2()
    expect(gate.available).toBe(2)
  })
  it('lowering the cap holds new work until enough have finished', async () => {
    const gate = new __testing.Semaphore(3)
    const a = await gate.acquire()
    const b = await gate.acquire()
    gate.setCap(1)
    let c = false
    const p = gate.acquire().then(() => (c = true))
    a()
    await Promise.resolve()
    expect(c).toBe(false)
    b()
    await p
    expect(c).toBe(true)
  })
})
