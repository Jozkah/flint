import { describe, it, expect } from 'vitest'
import { tooHeavyToHighlight } from '@/lib/highlightLimits'

describe('tooHeavyToHighlight', () => {
  it('allows ordinary source', () => {
    expect(tooHeavyToHighlight('const a = 1\nconst b = 2\n')).toBe(false)
  })
  it('flags a minified single line', () => {
    expect(tooHeavyToHighlight('x'.repeat(5000))).toBe(true)
  })
  it('flags huge content', () => {
    expect(tooHeavyToHighlight('a\n'.repeat(130_000))).toBe(true)
  })
  it('flags very many lines', () => {
    expect(tooHeavyToHighlight('\n'.repeat(7000))).toBe(true)
  })
})
