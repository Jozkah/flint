import { describe, it, expect } from 'vitest'
import {
  steppedValue,
  CONTEXT_SIZE_MIN,
  CONTEXT_SIZE_STEPS,
} from '@/lib/steppedValue'

const ctx = { min: CONTEXT_SIZE_MIN, steps: CONTEXT_SIZE_STEPS }

describe('steppedValue', () => {
  it('Default context size: + from Auto goes to 4096, then the next common size', () => {
    expect(steppedValue(null, 1, ctx)).toBe(4096)
    expect(steppedValue(4096, 1, ctx)).toBe(8192)
    expect(steppedValue(5000, 1, ctx)).toBe(8192)
    expect(steppedValue(8192, -1, ctx)).toBe(4096)
  })

  it('never goes below the minimum or stalls at the last size', () => {
    expect(steppedValue(4096, -1, ctx)).toBe(4096)
    expect(steppedValue(600, -1, ctx)).toBe(600)
    expect(steppedValue(100, -1, ctx)).toBe(CONTEXT_SIZE_MIN)
    expect(steppedValue(131072, 1, ctx)).toBe(131072 + 65536)
  })

  it('without steps keeps plain step arithmetic', () => {
    expect(steppedValue(0.1, 1, { step: 0.1 })).toBe(0.2)
    expect(steppedValue(1, -1, { min: 1 })).toBe(1)
  })
})
