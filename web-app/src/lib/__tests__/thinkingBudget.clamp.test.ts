import { describe, expect, it } from 'vitest'
import { clampThinkingBudget } from '../thinkingBudget'

describe('clampThinkingBudget', () => {
  it('caps the budget at 80% of max output tokens', () => {
    expect(clampThinkingBudget(20000, 10000)).toBe(8000)
    expect(clampThinkingBudget(5000, 10000)).toBe(5000)
  })

  it('never goes below 1024', () => {
    expect(clampThinkingBudget(100, 10000)).toBe(1024)
    expect(clampThinkingBudget(5000, 1000)).toBe(1024)
  })

  it('caps unlimited (-1) when the output limit is known', () => {
    expect(clampThinkingBudget(-1, 4096)).toBe(3276)
  })

  it('leaves the budget alone when the output limit is unknown', () => {
    expect(clampThinkingBudget(-1, undefined)).toBe(-1)
    expect(clampThinkingBudget(50000, 0)).toBe(50000)
  })
})
