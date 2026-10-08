import { describe, it, expect } from 'vitest'
import {
  aggregateStats,
  elapsedMs,
  subagentStats,
  tallyToolCalls,
} from '../coworkSubagentStats'
import type { CoworkTurn } from '@/types/coworkSession'

const tool = (name: string, over: Partial<CoworkTurn> = {}): CoworkTurn => ({
  role: 'tool',
  content: '',
  name,
  ...over,
})

describe('tallyToolCalls', () => {
  it('counts by tool and by how each call ended', () => {
    const counts = tallyToolCalls([
      { role: 'assistant', content: 'hi' },
      tool('read', { toolState: 'succeeded' }),
      tool('read', { toolState: 'failed' }),
      tool('grep', { toolState: 'running' }),
      tool('bash', { toolState: 'cancelled' }),
      tool('ls', { status: 'done' }),
      tool('ls', { isError: true }),
      tool('find', { status: 'running' }),
    ])
    expect(counts.total).toBe(7)
    expect(counts.succeeded).toBe(2)
    expect(counts.failed).toBe(3)
    expect(counts.active).toBe(2)
    expect(counts.byTool).toEqual({ read: 2, grep: 1, bash: 1, ls: 2, find: 1 })
  })

  it('is zero for no transcript', () => {
    expect(tallyToolCalls(undefined).total).toBe(0)
  })
})

describe('elapsedMs', () => {
  it('stops at endedAt once finished, ticks to now while running, is zero while queued', () => {
    expect(elapsedMs({ startedAt: 100, endedAt: 600, status: 'done' }, 9999)).toBe(500)
    expect(elapsedMs({ startedAt: 100, status: 'running' }, 400)).toBe(300)
    expect(elapsedMs({ startedAt: 100, status: 'queued' }, 400)).toBe(0)
    expect(elapsedMs({ startedAt: 500, status: 'running' }, 100)).toBe(0)
  })
})

describe('subagentStats', () => {
  const base = { startedAt: 0, endedAt: 2000, status: 'done' as const }

  it('uses the provider-reported tokens as they are, not approximate', () => {
    const s = subagentStats(
      {
        ...base,
        usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
        transcript: [{ role: 'assistant', content: 'x' }, tool('read')],
      },
      5000
    )
    expect(s).toMatchObject({
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 1000,
      approximate: false,
      turns: 1,
      elapsedMs: 2000,
    })
    expect(s.tools.total).toBe(1)
  })

  it('falls back to a marked estimate when nothing was reported', () => {
    const s = subagentStats(
      {
        ...base,
        transcript: [
          { role: 'assistant', content: 'a'.repeat(400) },
          tool('read', { result: 'b'.repeat(800) }),
        ],
        output: '',
      },
      5000
    )
    expect(s.approximate).toBe(true)
    expect(s.outputTokens).toBe(100)
    expect(s.inputTokens).toBe(200)
    expect(s.totalTokens).toBe(300)
  })

  it('reports zero, not an estimate, for a child that produced nothing', () => {
    const s = subagentStats({ ...base }, 0)
    expect(s.totalTokens).toBe(0)
    expect(s.approximate).toBe(false)
  })
})

describe('aggregateStats', () => {
  it('sums tokens and calls, and takes the longest child as the wall-clock', () => {
    const a = subagentStats(
      {
        startedAt: 0,
        endedAt: 1000,
        status: 'done',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        transcript: [tool('read'), tool('read')],
      },
      0
    )
    const b = subagentStats(
      {
        startedAt: 0,
        endedAt: 4000,
        status: 'done',
        transcript: [tool('grep'), { role: 'assistant', content: 'z'.repeat(40) }],
      },
      0
    )
    const sum = aggregateStats([a, b])
    expect(sum.totalTokens).toBe(a.totalTokens + b.totalTokens)
    expect(sum.approximate).toBe(true)
    expect(sum.tools.byTool).toEqual({ read: 2, grep: 1 })
    expect(sum.tools.total).toBe(3)
    expect(sum.elapsedMs).toBe(4000)
    expect(aggregateStats([]).totalTokens).toBe(0)
  })
})
