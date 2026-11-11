import { describe, it, expect } from 'vitest'
import {
  compactTokens,
  dailyTotals,
  formatCost,
  formatRate,
  isEmptyScan,
  parsePriceDraft,
  rootProblems,
  toggleAgent,
  type DayRow,
  type ScanSummary,
} from '../usageImport'

describe('usageImport helpers', () => {
  it('parses a price draft and rejects bad input', () => {
    expect(parsePriceDraft({ input: '3', output: '15', cacheRead: '', cacheWrite: '' })).toEqual({ input: 3, output: 15 })
    expect(parsePriceDraft({ input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' })).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    })
    expect(parsePriceDraft({ input: '', output: '15', cacheRead: '', cacheWrite: '' })).toBeNull()
    expect(parsePriceDraft({ input: '-1', output: '15', cacheRead: '', cacheWrite: '' })).toBeNull()
    expect(parsePriceDraft({ input: '3', output: 'x', cacheRead: '', cacheWrite: '' })).toBeNull()
    expect(parsePriceDraft({ input: '3', output: '1', cacheRead: 'abc', cacheWrite: '' })).toBeNull()
  })

  it('toggles agents in and out of the filter', () => {
    expect(toggleAgent([], 'codex')).toEqual(['codex'])
    expect(toggleAgent(['codex', 'flint'], 'codex')).toEqual(['flint'])
  })

  it('formats without inventing a zero cost', () => {
    expect(formatCost(null)).toBe('—')
    expect(formatCost(0.5)).toBe('$0.5000')
    expect(formatCost(12.345)).toBe('$12.35')
    expect(formatRate(null)).toBe('—')
    expect(formatRate(0.8)).toBe('80.0%')
    expect(compactTokens(1_500_000)).toBe('1.50M')
    expect(compactTokens(999)).toBe('999')
  })

  it('sums day rows across agents, oldest first', () => {
    const row = (day: string, total: number) => ({ day, total }) as DayRow
    expect(dailyTotals([row('2026-10-02', 5), row('2026-10-01', 2), row('2026-10-02', 1)])).toEqual([
      { day: '2026-10-01', total: 2 },
      { day: '2026-10-02', total: 6 },
    ])
  })

  it('reports folders that could not be read and empty scans', () => {
    const summary = {
      roots: [
        { agent: 'claude-code', path: 'a', status: 'ok', files: 1, compressedSkipped: 0 },
        { agent: 'codex', path: 'b', status: 'denied', files: 0, compressedSkipped: 0 },
      ],
    } as ScanSummary
    expect(rootProblems(summary).map((r) => r.path)).toEqual(['b'])
    expect(rootProblems(null)).toEqual([])
    expect(isEmptyScan(null)).toBe(true)
  })
})
