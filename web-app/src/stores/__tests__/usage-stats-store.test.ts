import { beforeEach, describe, expect, it } from 'vitest'
import { change, dayKey, summarize, useUsageStats } from '../usage-stats-store'

const DAY = 86_400_000
const noon = new Date(2026, 8, 20, 12).getTime()

describe('usage stats', () => {
  beforeEach(() => useUsageStats.getState().reset())

  it('buckets generations by local day and derives speed from timed replies', () => {
    const s = useUsageStats.getState()
    s.recordGeneration({ tokens: 900, durationMs: 20_000, at: noon })
    s.recordGeneration({ tokens: 100, durationMs: 0, at: noon })
    s.recordGeneration({ tokens: 0, durationMs: 5_000, at: noon })
    const day = useUsageStats.getState().days[dayKey(noon)]
    expect(day).toMatchObject({ tokens: 1000, replies: 2, timedTokens: 900, genMs: 20_000 })
    const sum = summarize(useUsageStats.getState().days, 7, noon)
    expect(sum.tokens).toBe(1000)
    expect(sum.speed).toBeCloseTo(45)
    expect(sum.series).toHaveLength(7)
    expect(sum.series[6].key).toBe(dayKey(noon))
  })

  it('reports tool success as a share, and none without calls', () => {
    const s = useUsageStats.getState()
    expect(summarize(s.days, 7, noon).toolSuccess).toBeNull()
    s.recordToolCall(true, noon)
    s.recordToolCall(true, noon)
    s.recordToolCall(false, noon)
    expect(summarize(useUsageStats.getState().days, 7, noon).toolSuccess).toBeCloseTo(2 / 3)
  })

  it('keeps ranges apart and compares them', () => {
    const s = useUsageStats.getState()
    s.recordGeneration({ tokens: 200, durationMs: 0, at: noon })
    s.recordGeneration({ tokens: 100, durationMs: 0, at: noon - 7 * DAY })
    const days = useUsageStats.getState().days
    const cur = summarize(days, 7, noon)
    const prev = summarize(days, 7, noon - 7 * DAY)
    expect(cur.tokens).toBe(200)
    expect(prev.tokens).toBe(100)
    expect(change(cur.tokens, prev.tokens)).toBe(1)
    expect(change(5, 0)).toBeNull()
  })

  it('keeps the newest activity first and bounded', () => {
    const s = useUsageStats.getState()
    for (let i = 0; i < 130; i++) s.pushActivity({ kind: 'model-loaded', title: `m${i}`, at: i })
    const list = useUsageStats.getState().activity
    expect(list).toHaveLength(120)
    expect(list[0].title).toBe('m129')
  })
})
