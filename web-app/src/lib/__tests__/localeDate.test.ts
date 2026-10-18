import { describe, expect, it } from 'vitest'
import { formatShortDate } from '../localeDate'

describe('formatShortDate (T7-092)', () => {
  it('formats in the UI language, not the system one', () => {
    expect(formatShortDate('2026-08-20T00:00:00Z', 'ja')).toMatch(/2026年8月2[01]日/)
    expect(formatShortDate('2026-08-20T00:00:00Z', 'en')).toMatch(/Aug 2[01], 2026/)
  })
  it('maps the app codes Intl does not know and survives bad input', () => {
    expect(formatShortDate('2026-08-20T12:00:00Z', 'vn')).toMatch(/2026/)
    expect(formatShortDate('nope', 'en')).toBeNull()
    expect(formatShortDate(undefined, 'en')).toBeNull()
  })
})
