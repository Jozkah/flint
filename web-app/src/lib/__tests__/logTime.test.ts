import { describe, expect, it } from 'vitest'
import { formatLogTimestamp, parseLogTimestamp } from '../logTime'

describe('log timestamps', () => {
  it('reads a log line time as UTC, which is how the file records it', () => {
    expect(parseLogTimestamp('2026-10-17 16:10:08')).toBe(Date.UTC(2026, 9, 17, 16, 10, 8))
    expect(parseLogTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(parseLogTimestamp('garbage')).toBeNaN()
  })

  it('shows the time in the local zone, like the rest of the UI', () => {
    const at = Date.UTC(2026, 9, 17, 16, 10, 8)
    const local = new Date(at).toLocaleTimeString('en-GB', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    expect(formatLogTimestamp('2026-10-17 16:10:08')).toBe(local)
    expect(formatLogTimestamp('garbage')).toBe('garbage')
  })
})
